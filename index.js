const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' }));

const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LVwgDeO2cuDnM6GivUOJ0Rh3S48HhXWf4WKPKItoqXgQ';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rtnnpwzclkcipwalbhjm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_b7bcdrIrWfoKt6golOQ1Iw_2y1DYkrh';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function supabase(method, table, body = null, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (method === 'GET' || method === 'POST') return res.json();
  return null;
}

// Load categories and rules from Supabase
let CATS_CACHE = null;
let RULES_CACHE = null;
let CACHE_TIME = 0;

async function getSettings() {
  if (Date.now() - CACHE_TIME < 60000 && CATS_CACHE && RULES_CACHE) {
    return { cats: CATS_CACHE, rules: RULES_CACHE };
  }
  try {
    const rows = await supabase('GET', 'settings', null, '?select=*');
    const cats = {};
    let rules = [];
    (rows || []).forEach(r => {
      try {
        if (r.key === 'CATS') Object.assign(cats, JSON.parse(r.value));
        if (r.key === 'RULES') rules = JSON.parse(r.value);
      } catch(e) {}
    });
    CATS_CACHE = cats;
    RULES_CACHE = rules;
    CACHE_TIME = Date.now();
    return { cats, rules };
  } catch(e) {
    return { cats: {}, rules: [] };
  }
}

async function askGemini(contents, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 500, temperature: 0 } })
      });
      const data = await res.json();
      if (res.status === 429) {
        console.log(`Rate limit, aguardando ${(i+1)*3}s...`);
        await new Promise(r => setTimeout(r, (i+1)*3000));
        continue;
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

async function getStats() {
  const [tx, salaries, entries] = await Promise.all([
    supabase('GET', 'transactions', null, '?select=*'),
    supabase('GET', 'salaries', null, '?select=*'),
    supabase('GET', 'entries', null, '?select=*')
  ]);
  const txArr = Array.isArray(tx) ? tx : [];
  const salArr = Array.isArray(salaries) ? salaries : [];
  const entArr = Array.isArray(entries) ? entries : [];
  const debitos = txArr.filter(t => !t.is_credit);
  const creditos = txArr.filter(t => t.is_credit);
  const bruto = debitos.reduce((a, t) => a + parseFloat(t.value||0), 0);
  const credTotal = creditos.reduce((a, t) => a + Math.abs(parseFloat(t.value||0)), 0);
  const liquido = bruto - credTotal;
  const totalIn = salArr.reduce((a,s)=>a+parseFloat(s.salary||0),0) + entArr.reduce((a,e)=>a+parseFloat(e.value||0),0);
  const byCat = {};
  debitos.forEach(t => { byCat[t.cat] = (byCat[t.cat]||0) + parseFloat(t.value||0); });
  return { bruto, credTotal, liquido, totalIn, saldo: totalIn-liquido, byCat, txCount: debitos.length };
}

const fmt = v => 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// Smart transaction parser using rules from Supabase
async function parseTransaction(msg) {
  const lower = msg.toLowerCase().trim();
  const { cats, rules } = await getSettings();

  // Extract value - look for numbers
  const numMatch = msg.match(/\b(\d+(?:[.,]\d{1,2})?)\b/);
  if (!numMatch) return { encontrou: false };
  const valor = parseFloat(numMatch[1].replace(',', '.'));
  if (!valor || valor <= 0 || valor > 100000) return { encontrou: false };

  // Match category using rules from Supabase (longest match first)
  let categoria = null;
  let matchedRule = null;

  // Sort rules by keyword length descending (more specific first)
  const sortedRules = [...rules].sort((a, b) => b[0].length - a[0].length);
  
  for (const [kw, cat] of sortedRules) {
    if (lower.includes(kw.toLowerCase())) {
      categoria = cat;
      matchedRule = kw;
      break;
    }
  }

  // If no rule matched, try Gemini
  if (!categoria) {
    const catList = Object.entries(cats).map(([id, c]) => `${id}="${(c&&c.label)||id}"`).join(', ');
    try {
      const text = await askGemini([{ role: 'user', parts: [{ text:
        `Mensagem: "${msg}"\nData hoje: ${new Date().toISOString().slice(0,10)}\n` +
        `Categorias disponíveis: ${catList||'mercado, automovel, compras, saude, transporte, outros'}\n` +
        `Retorne APENAS JSON: {"encontrou":true,"valor":${valor},"descricao":"texto curto","categoria":"id_da_categoria","data":"${new Date().toISOString().slice(0,10)}"}\n` +
        `Ou {"encontrou":false} se não for um gasto.`
      }] }]);
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (parsed.encontrou) return parsed;
    } catch(e) {}
    categoria = 'outros';
  }

  // Build description
  const desc = lower
    .replace(/\b\d+([.,]\d{1,2})?\b/, '')
    .replace(/\b(reais|real|r\$|gastei|paguei|comprei)\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ') || msg.slice(0, 40);

  return {
    encontrou: true,
    valor,
    descricao: desc.slice(0, 60) || msg.slice(0, 40),
    categoria,
    data: new Date().toISOString().slice(0, 10)
  };
}

async function sendWhatsApp(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: from, To: to, Body: message })
  });
  return res.json();
}

// Rota PDF
app.post('/process-pdf', async (req, res) => {
  const { base64, cats, rules } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 obrigatório' });
  const rulesText = (rules||[]).slice(0,40).map(r=>`"${r[0]}"→${r[1]}`).join('; ');
  const catsText = Object.keys(cats||{}).join(',') || 'mercado,automovel,compras,assinatura,saude,transporte,pet,lazer,servicos,credito,outros';
  try {
    const text = await askGemini([{ role: 'user', parts: [
      { inlineData: { mimeType: 'application/pdf', data: base64 } },
      { text: `Extraia TODOS os lançamentos desta fatura de cartão. Retorne APENAS JSON:\n{"transactions":[{"date":"YYYY-MM-DD","desc":"nome","value":0.00,"holder":"titular","cat":"cat_id","parc":"N/T ou null","obs":""}]}\nCategorias: ${catsText}\nRegras: ${rulesText}\nDébito=positivo, crédito/estorno=negativo.` }
    ]}]);
    res.json(JSON.parse(text.replace(/```json|```/g,'').trim()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rota Chat
app.post('/chat', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    const text = await askGemini([{ role: 'user', parts: [{ text: (context||'') + '\n\nPergunta: ' + message }] }]);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const from = req.body.From;
  const body = (req.body.Body||'').trim();
  const lower = body.toLowerCase();
  console.log(`📩 ${from}: "${body}"`);
  if (!from || !body) return;

  const { cats } = await getSettings();
  const emojis = { mercado:'🛒', automovel:'🚗', compras:'🛍️', assinatura:'📺', saude:'💊', transporte:'🚌', pet:'🐾', lazer:'🎉', servicos:'🔧', credito:'✅', outros:'📝' };
  function getEmoji(cat) { return emojis[cat] || '📝'; }
  function getCatLabel(cat) { return (cats[cat]&&cats[cat].label)||cat||'outros'; }

  try {
    if (['ajuda','help','oi','olá','ola','menu','start'].includes(lower)) {
      await sendWhatsApp(from,
        `🤖 *Assistente Financeiro*\n\n` +
        `💬 *Exemplos:*\n"30 gasolina carro"\n"20 gasolina moto"\n"mercado 120"\n"uber 25"\n"400 manutenção carro"\n\n` +
        `📊 *Consultas:*\n"resumo" — visão geral\n"saldo" — quanto sobrou\n"maiores gastos"\n"ultimo" — último lançamento`
      ); return;
    }

    if (lower.includes('resumo') || lower.includes('fluxo') || lower.includes('visão geral')) {
      const s = await getStats();
      await sendWhatsApp(from, `📊 *Resumo financeiro*\n\n💳 Bruto: ${fmt(s.bruto)}\n✅ Créditos: -${fmt(s.credTotal)}\n💰 Líquido: ${fmt(s.liquido)}\n\n💵 Renda: ${fmt(s.totalIn)}\n🏦 Saldo: ${fmt(s.saldo)}\n📦 Lançamentos: ${s.txCount}`);
      return;
    }

    if (lower.includes('saldo') || lower.includes('quanto tenho') || lower.includes('quanto sobrou')) {
      const s = await getStats();
      await sendWhatsApp(from, `${s.saldo>=0?'🟢':'🔴'} *Saldo: ${fmt(s.saldo)}*\n\n💵 Renda: ${fmt(s.totalIn)}\n💳 Fatura: ${fmt(s.liquido)}\n${s.saldo<0?'⚠️ Acima da renda!':'✅ Dentro do orçamento!'}`);
      return;
    }

    if (lower.includes('maiores gastos') || lower.includes('categorias') || lower.includes('onde gastei')) {
      const s = await getStats();
      const catsList = Object.entries(s.byCat).sort((a,b)=>b[1]-a[1]).slice(0,5);
      if (!catsList.length) { await sendWhatsApp(from, '📊 Nenhum gasto ainda.'); return; }
      await sendWhatsApp(from, `📊 *Top categorias*\n\n${catsList.map((c,i)=>`${i+1}. ${getEmoji(c[0])} ${getCatLabel(c[0])}: ${fmt(c[1])}`).join('\n')}`);
      return;
    }

    if (lower.includes('ultimo') || lower.includes('último')) {
      const tx = await supabase('GET','transactions',null,'?select=*&order=created_at.desc&limit=1');
      if (!Array.isArray(tx)||!tx.length) { await sendWhatsApp(from,'📝 Nenhum lançamento.'); return; }
      const t = tx[0];
      await sendWhatsApp(from, `📝 *Último lançamento*\n\n${t.description}\n💰 ${fmt(t.value)}\n📂 ${getCatLabel(t.cat)}\n📅 ${t.date}\n👤 ${t.holder}`);
      return;
    }

    const parsed = await parseTransaction(body);
    console.log('Parsed:', JSON.stringify(parsed));

    if (parsed.encontrou && parsed.valor > 0) {
      const phoneLeandra = process.env.PHONE_LEANDRA || '';
      const holder = phoneLeandra && from.replace(/\D/g,'').includes(phoneLeandra.replace(/\D/g,'')) ? 'Leandra' : 'Thiago';
      await supabase('POST','transactions',{
        date: parsed.data,
        description: parsed.descricao,
        value: parsed.valor,
        holder,
        cat: parsed.categoria,
        parc: null,
        obs: `Via WhatsApp (${from})`,
        is_credit: false
      });
      // Invalidate cache
      CACHE_TIME = 0;
      await sendWhatsApp(from,
        `${getEmoji(parsed.categoria)} *Lançado!*\n\n` +
        `📝 ${parsed.descricao}\n` +
        `💰 ${fmt(parsed.valor)}\n` +
        `📂 ${getCatLabel(parsed.categoria)}\n` +
        `📅 ${parsed.data}\n` +
        `👤 ${holder}\n\n` +
        `_Digite "resumo" para ver seus gastos_`
      );
    } else {
      const s = await getStats();
      let resposta = '';
      try {
        resposta = await askGemini([{ role:'user', parts:[{ text:
          `Assistente financeiro do Thiago. Fatura=${fmt(s.liquido)}, saldo=${fmt(s.saldo)}, renda=${fmt(s.totalIn)}.\nMensagem: "${body}"\nResponda em português, direto, máx 2 linhas, use emojis.`
        }]}]);
      } catch(e) {}
      await sendWhatsApp(from, resposta || '🤖 Não entendi. Digite *ajuda* para ver os comandos.');
    }
  } catch(err) {
    console.error('Webhook error:', err);
    try { await sendWhatsApp(from, '❌ Erro temporário. Tente novamente.'); } catch(e) {}
  }
});

app.get('/', (req, res) => res.send('🤖 Bot Financeiro rodando! ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor na porta ${PORT}`));
