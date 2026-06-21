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

async function askGemini(contents, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 3000, temperature: 0.1 } })
      });
      const data = await res.json();
      if (res.status === 429) {
        console.log(`Rate limit, aguardando ${(i + 1) * 3}s...`);
        await new Promise(r => setTimeout(r, (i + 1) * 3000));
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
  const bruto = debitos.reduce((a, t) => a + parseFloat(t.value || 0), 0);
  const credTotal = creditos.reduce((a, t) => a + Math.abs(parseFloat(t.value || 0)), 0);
  const liquido = bruto - credTotal;
  const totalIn = salArr.reduce((a, s) => a + parseFloat(s.salary || 0), 0)
    + entArr.reduce((a, e) => a + parseFloat(e.value || 0), 0);
  const byCat = {};
  debitos.forEach(t => { byCat[t.cat] = (byCat[t.cat] || 0) + parseFloat(t.value || 0); });
  return { bruto, credTotal, liquido, totalIn, saldo: totalIn - liquido, byCat, txCount: debitos.length };
}

const fmt = v => 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const emojis = { mercado:'🛒', automovel:'🚗', compras:'🛍️', assinatura:'📺', saude:'💊', transporte:'🚌', pet:'🐾', lazer:'🎉', servicos:'🔧', credito:'✅', outros:'📝' };

async function parseTransaction(msg) {
  const text = await askGemini([{ role: 'user', parts: [{ text: `Analise esta mensagem e extraia informações de gasto financeiro.
Mensagem: "${msg}"
Retorne APENAS JSON sem markdown:
{"encontrou": true, "valor": 0.00, "descricao": "nome do produto ou local", "categoria": "mercado|automovel|compras|assinatura|saude|transporte|pet|lazer|servicos|outros", "data": "YYYY-MM-DD"}
Se não encontrar um gasto claro, retorne: {"encontrou": false}
Data de hoje: ${new Date().toISOString().slice(0, 10)}` }] }]);
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch (e) { return { encontrou: false }; }
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

// ── Rota PDF ──
app.post('/process-pdf', async (req, res) => {
  const { base64, cats, rules } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 obrigatório' });
  const rulesText = (rules || []).slice(0, 30).map(r => `"${r[0]}"→${r[1]}`).join('; ');
  const catsText = (cats || ['mercado','automovel','compras','assinatura','saude','transporte','pet','lazer','servicos','credito','outros']).join(',');
  const prompt = `Extraia TODOS os lançamentos desta fatura incluindo créditos/estornos (valor negativo). Retorne APENAS JSON sem markdown:
{"transactions":[{"date":"YYYY-MM-DD","desc":"nome limpo","value":0.00,"holder":"titular","cat":"cat_id","parc":"N/T ou null","obs":""}]}
Categorias: ${catsText}
Regras: ${rulesText}
Débito=positivo, crédito/estorno=negativo. Parcela formato "1/3".`;
  try {
    const text = await askGemini([{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: base64 } }, { text: prompt }] }]);
    res.json(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch (e) {
    console.error('PDF error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Rota Chat IA ──
app.post('/chat', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    const text = await askGemini([{ role: 'user', parts: [{ text: (context || '') + '\n\nPergunta: ' + message }] }]);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Webhook WhatsApp ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();
  if (!from || !body) return;
  try {
    if (['ajuda','help','oi','olá','ola','menu','start'].includes(lower)) {
      await sendWhatsApp(from,
        `🤖 *Assistente Financeiro*\n\n` +
        `💬 *Lançar gasto:*\n"Gastei R$50 de gasolina"\n"Mercado R$120 hoje"\n"Paguei 80 no almoço"\n"Uber R$25"\n\n` +
        `📊 *Consultas:*\n"Resumo" — visão geral\n"Saldo" — quanto sobrou\n"Maiores gastos" — top categorias\n"Último" — último lançamento\n\n` +
        `_Pode escrever naturalmente!_ 😊`);
      return;
    }
    if (lower.includes('resumo') || lower.includes('fluxo') || lower.includes('visão geral')) {
      const s = await getStats();
      await sendWhatsApp(from, `📊 *Resumo financeiro*\n\n💳 Fatura bruta: ${fmt(s.bruto)}\n✅ Créditos: -${fmt(s.credTotal)}\n💰 Fatura líquida: ${fmt(s.liquido)}\n\n💵 Renda total: ${fmt(s.totalIn)}\n🏦 Saldo disponível: ${fmt(s.saldo)}\n\n📦 Lançamentos: ${s.txCount}`);
      return;
    }
    if (lower.includes('saldo') || lower.includes('quanto tenho') || lower.includes('quanto sobrou') || lower.includes('quanto resta')) {
      const s = await getStats();
      await sendWhatsApp(from, `${s.saldo >= 0 ? '🟢' : '🔴'} *Saldo: ${fmt(s.saldo)}*\n\n💵 Renda: ${fmt(s.totalIn)}\n💳 Fatura: ${fmt(s.liquido)}\n\n${s.saldo < 0 ? '⚠️ Gastos acima da renda!' : '✅ Dentro do orçamento!'}`);
      return;
    }
    if (lower.includes('maiores gastos') || lower.includes('categorias') || lower.includes('onde gastei')) {
      const s = await getStats();
      const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!cats.length) { await sendWhatsApp(from, '📊 Nenhum gasto registrado ainda.'); return; }
      await sendWhatsApp(from, `📊 *Top 5 categorias*\n\n${cats.map((c, i) => `${i+1}. ${emojis[c[0]]||'📝'} ${c[0]}: ${fmt(c[1])}`).join('\n')}\n\n💳 Total: ${fmt(s.byCat ? Object.values(s.byCat).reduce((a,b)=>a+b,0) : 0)}`);
      return;
    }
    if (lower.includes('último') || lower.includes('ultimo')) {
      const tx = await supabase('GET', 'transactions', null, '?select=*&order=created_at.desc&limit=1');
      if (!Array.isArray(tx) || !tx.length) { await sendWhatsApp(from, '📝 Nenhum lançamento encontrado.'); return; }
      const t = tx[0];
      await sendWhatsApp(from, `📝 *Último lançamento*\n\n${t.description}\n💰 ${fmt(t.value)}\n📂 ${t.cat}\n📅 ${t.date}\n👤 ${t.holder}`);
      return;
    }
    const parsed = await parseTransaction(body);
    if (parsed.encontrou && parsed.valor > 0) {
      const phoneLeandra = process.env.PHONE_LEANDRA || '';
      const holder = phoneLeandra && from.includes(phoneLeandra) ? 'Leandra' : 'Thiago';
      await supabase('POST', 'transactions', { date: parsed.data, description: parsed.descricao, value: parsed.valor, holder, cat: parsed.categoria, parc: null, obs: `Via WhatsApp (${from})`, is_credit: false });
      await sendWhatsApp(from, `${emojis[parsed.categoria]||'📝'} *Lançado!*\n\n📝 ${parsed.descricao}\n💰 ${fmt(parsed.valor)}\n📂 ${parsed.categoria}\n📅 ${parsed.data}\n👤 ${holder}\n\n_Digite "resumo" para ver seus gastos_`);
    } else {
      const s = await getStats();
      const context = `Você é assistente financeiro do Thiago. Dados: fatura=${fmt(s.liquido)}, saldo=${fmt(s.saldo)}, renda=${fmt(s.totalIn)}, ${s.txCount} lançamentos. Responda em português, direto, máx 3 linhas, use emojis.`;
      const resposta = await askGemini([{ role: 'user', parts: [{ text: context + '\n\nMensagem: ' + body }] }]);
      await sendWhatsApp(from, resposta || '🤖 Não entendi. Digite *ajuda* para os comandos.');
    }
  } catch (err) {
    console.error('Webhook error:', err);
    try { await sendWhatsApp(from, '❌ Erro temporário. Tente novamente.'); } catch (e) {}
  }
});

app.get('/', (req, res) => res.send('🤖 Bot Financeiro rodando! ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor na porta ${PORT}`));
