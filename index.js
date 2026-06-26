const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' }));

const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LVwgDeO2cuDnM6GivUOJ0Rh3S48HhXWf4WKPKItoqXgQ';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rtnnpwzclkcipwalbhjm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_b7bcdrIrWfoKt6golOQ1Iw_2y1DYkrh';
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'Personal financial';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Supabase ──
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

// ── Settings cache ──
let CATS_CACHE = null, RULES_CACHE = null, CACHE_TIME = 0;
async function getSettings() {
  if (Date.now() - CACHE_TIME < 60000 && CATS_CACHE && RULES_CACHE) {
    return { cats: CATS_CACHE, rules: RULES_CACHE };
  }
  try {
    const rows = await supabase('GET', 'settings', null, '?select=*');
    let cats = {}, rules = [];
    (rows || []).forEach(r => {
      try {
        if (r.key === 'CATS') Object.assign(cats, JSON.parse(r.value));
        if (r.key === 'RULES') rules = JSON.parse(r.value);
      } catch(e) {}
    });
    CATS_CACHE = cats; RULES_CACHE = rules; CACHE_TIME = Date.now();
    return { cats, rules };
  } catch(e) { return { cats: {}, rules: [] }; }
}

// ── Gemini com retry ──
async function askGemini(contents, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 1000, temperature: 0.1 } })
      });
      const data = await res.json();
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, (i+1)*3000));
        continue;
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch(e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

// ── Download mídia da Evolution API ──
async function downloadMedia(mediaUrl) {
  // A Evolution API retorna a mídia como base64 diretamente no webhook
  // Esta função é usada como fallback para URLs externas
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error('Erro ao baixar mídia: ' + res.status);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Stats ──
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
  const bruto = debitos.reduce((a,t)=>a+parseFloat(t.value||0),0);
  const credTotal = creditos.reduce((a,t)=>a+Math.abs(parseFloat(t.value||0)),0);
  const liquido = bruto - credTotal;
  const totalIn = salArr.reduce((a,s)=>a+parseFloat(s.salary||0),0)+entArr.reduce((a,e)=>a+parseFloat(e.value||0),0);
  const byCat = {};
  debitos.forEach(t=>{ byCat[t.cat]=(byCat[t.cat]||0)+parseFloat(t.value||0); });
  return { bruto, credTotal, liquido, totalIn, saldo:totalIn-liquido, byCat, txCount:debitos.length };
}

const fmt = v => 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// ── Parse transação por texto ──
async function parseByText(msg) {
  const lower = msg.toLowerCase().trim();
  const { cats, rules } = await getSettings();

  const numMatch = msg.match(/\b(\d+(?:[.,]\d{1,2})?)\b/);
  if (!numMatch) return { encontrou: false };
  const valor = parseFloat(numMatch[1].replace(',','.'));
  if (!valor || valor <= 0 || valor > 100000) return { encontrou: false };

  const sortedRules = [...rules].sort((a,b)=>b[0].length-a[0].length);
  let categoria = null;
  for (const [kw, cat] of sortedRules) {
    if (lower.includes(kw.toLowerCase())) { categoria = cat; break; }
  }

  if (!categoria) {
    const catList = Object.entries(cats).map(([id,c])=>`${id}="${(c&&c.label)||id}"`).join(', ');
    try {
      const text = await askGemini([{ role:'user', parts:[{ text:
        `Mensagem: "${msg}"\nCategorias: ${catList||'mercado,automovel,compras,saude,transporte,outros'}\n` +
        `Retorne APENAS JSON: {"encontrou":true,"valor":${valor},"descricao":"texto","categoria":"id","data":"${new Date().toISOString().slice(0,10)}"}\nOu {"encontrou":false}`
      }]}]);
      const parsed = JSON.parse(text.replace(/```json|```/g,'').trim());
      if (parsed.encontrou) return parsed;
    } catch(e) {}
    categoria = 'outros';
  }

  const desc = lower.replace(/\b\d+([.,]\d{1,2})?\b/,'').replace(/\b(reais|real|r\$|gastei|paguei|comprei|de|no|na)\b/gi,'').trim().replace(/\s+/g,' ');
  return { encontrou:true, valor, descricao:(desc||msg).slice(0,60), categoria, data:new Date().toISOString().slice(0,10) };
}

// ── Parse áudio ──
async function parseAudio(base64, mimeType) {
  const { cats, rules } = await getSettings();
  const catList = Object.entries(cats).map(([id,c])=>`${id}="${(c&&c.label)||id}"`).join(', ');
  const sortedRules = [...rules].sort((a,b)=>b[0].length-a[0].length);
  const rulesText = sortedRules.slice(0,30).map(r=>`"${r[0]}"→${r[1]}`).join('; ');

  const text = await askGemini([{ role:'user', parts:[
    { inlineData: { mimeType: mimeType || 'audio/ogg', data: base64 } },
    { text: `Transcreva este áudio e extraia informações de gasto financeiro.\n` +
      `Categorias disponíveis: ${catList||'mercado,automovel,compras,saude,transporte,outros'}\n` +
      `Regras de categorização (mais específicas têm prioridade): ${rulesText}\n` +
      `Retorne APENAS JSON:\n{"encontrou":true,"transcricao":"texto falado","valor":0.00,"descricao":"nome do gasto","categoria":"id","data":"${new Date().toISOString().slice(0,10)}"}\n` +
      `Ou {"encontrou":false,"transcricao":"texto"} se não for um gasto financeiro.`
    }
  ]}]);
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

// ── Parse imagem ──
async function parseImage(base64, mimeType) {
  const { cats, rules } = await getSettings();
  const catList = Object.entries(cats).map(([id,c])=>`${id}="${(c&&c.label)||id}"`).join(', ');
  const sortedRules = [...rules].sort((a,b)=>b[0].length-a[0].length);
  const rulesText = sortedRules.slice(0,30).map(r=>`"${r[0]}"→${r[1]}`).join('; ');

  const text = await askGemini([{ role:'user', parts:[
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
    { text: `Analise esta imagem (comprovante, nota fiscal, ticket ou foto de produto/serviço) e extraia informações de gasto financeiro.\n` +
      `Categorias: ${catList||'mercado,automovel,compras,saude,transporte,outros'}\n` +
      `Regras: ${rulesText}\n` +
      `Retorne APENAS JSON:\n{"encontrou":true,"valor":0.00,"descricao":"estabelecimento ou produto","categoria":"id","data":"YYYY-MM-DD","obs":"info adicional"}\n` +
      `Ou {"encontrou":false} se não identificar um gasto.`
    }
  ]}]);
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

// ── Enviar WhatsApp via Evolution API ──
async function sendWhatsApp(to, message) {
  // 'to' vem no formato '5511999999999' (apenas números)
  const number = to.replace(/\D/g, '');
  const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_API_KEY
    },
    body: JSON.stringify({
      number,
      text: message
    })
  });
  const data = await res.json();
  console.log('✅ Enviado via Evolution API:', data.key?.id || JSON.stringify(data));
  return data;
}

// ── Salvar transação ──
async function salvarTransacao(parsed, from) {
  const phoneLeandra = process.env.PHONE_LEANDRA || '';
  const holder = phoneLeandra && from.replace(/\D/g,'').includes(phoneLeandra.replace(/\D/g,'')) ? 'Leandra' : 'Thiago';
  const { cats } = await getSettings();
  const catLabel = (cats[parsed.categoria]&&cats[parsed.categoria].label) || parsed.categoria || 'outros';

  await supabase('POST','transactions',{
    date: parsed.data || new Date().toISOString().slice(0,10),
    description: parsed.descricao,
    value: parsed.valor,
    holder,
    cat: parsed.categoria || 'outros',
    parc: null,
    obs: (parsed.obs||'') + ` Via WhatsApp (${from})`,
    is_credit: false
  });

  CACHE_TIME = 0;
  const emojis = { mercado:'🛒', automovel:'🚗', compras:'🛍️', assinatura:'📺', saude:'💊', transporte:'🚌', pet:'🐾', lazer:'🎉', servicos:'🔧', credito:'✅', outros:'📝' };
  const emoji = emojis[parsed.categoria] || '📝';

  return `${emoji} *Lançado com sucesso!*\n\n` +
    `📝 ${parsed.descricao}\n` +
    `💰 ${fmt(parsed.valor)}\n` +
    `📂 ${catLabel}\n` +
    `📅 ${parsed.data}\n` +
    `👤 ${holder}\n\n` +
    `_Digite "resumo" para ver seus gastos_`;
}

// ── Rotas PDF e Chat ──
app.post('/process-pdf', async (req, res) => {
  const { base64, cats, rules } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 obrigatório' });
  const rulesText = (rules||[]).slice(0,40).map(r=>`"${r[0]}"→${r[1]}`).join('; ');
  const catsText = Object.keys(cats||{}).join(',') || 'mercado,automovel,compras,assinatura,saude,transporte,pet,lazer,servicos,credito,outros';
  try {
    const text = await askGemini([{ role:'user', parts:[
      { inlineData: { mimeType:'application/pdf', data:base64 } },
      { text:`Extraia TODOS os lançamentos desta fatura. Retorne APENAS JSON:\n{"transactions":[{"date":"YYYY-MM-DD","desc":"nome","value":0.00,"holder":"titular","cat":"cat_id","parc":"N/T ou null","obs":""}]}\nCategorias: ${catsText}\nRegras: ${rulesText}\nDébito=positivo, crédito=negativo.` }
    ]}]);
    res.json(JSON.parse(text.replace(/```json|```/g,'').trim()));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/chat', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message obrigatório' });
  try {
    const text = await askGemini([{ role:'user', parts:[{ text:(context||'')+'\n\nPergunta: '+message }]}]);
    res.json({ text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════
// WEBHOOK WHATSAPP — Evolution API
// ════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    console.log('📩 Webhook Evolution FULL:', JSON.stringify(event));

    // Ignorar eventos que não são mensagens recebidas
    if (event.event !== 'messages.upsert') return;

    // Logar evento completo para debug
    console.log('🔍 event.event:', event.event);
    console.log('🔍 event.data keys:', Object.keys(event.data || {}).join(','));
    console.log('🔍 event.data.status:', event.data?.status);
    console.log('🔍 event.data.message keys:', Object.keys(event.data?.message || {}).join(','));

    // Ignorar se não tem dados
    const msg = event.data;
    if (!msg) { console.log('❌ Sem msg, ignorando'); return; }

    // Ignorar mensagens enviadas pelo próprio bot
    if (msg.key?.fromMe) { console.log('❌ fromMe, ignorando'); return; }

    const from = msg.key?.remoteJid?.replace('@s.whatsapp.net', '') || '';
    if (!from) { console.log('❌ Sem from, ignorando'); return; }

    // Extrair conteúdo da mensagem
    const msgContent = msg.message || {};
    const body = (
      msgContent.conversation ||
      msgContent.extendedTextMessage?.text ||
      msgContent.imageMessage?.caption ||
      msgContent.audioMessage?.caption ||
      ''
    ).trim();
    const lower = body.toLowerCase();

    console.log(`📨 From: ${from} | Body: "${body}" | Status: ${msg.status} | MsgKeys: ${Object.keys(msgContent).join(',')}`);

    // Ignorar se não tem conteúdo e é só notificação de status
    if (!body && !msgContent.audioMessage && !msgContent.pttMessage && !msgContent.imageMessage) {
      console.log('❌ Sem conteúdo útil, ignorando');
      return;
    }

    // Detectar tipo de mídia
    const isAudio = !!(msgContent.audioMessage || msgContent.pttMessage);
    const isImage = !!(msgContent.imageMessage);

    console.log(`📩 ${from}: "${body}" | áudio: ${isAudio} | imagem: ${isImage}`);

    const { cats } = await getSettings();
    function getCatLabel(cat){ return (cats[cat]&&cats[cat].label)||cat||'outros'; }

    // ── ÁUDIO ──
    if (isAudio) {
      await sendWhatsApp(from, '🎤 Recebi seu áudio! Processando...');
      try {
        // Baixar mídia via Evolution API
        const mediaRes = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
          body: JSON.stringify({ message: msg.message, convertToMp4: false })
        });
        const mediaData = await mediaRes.json();
        const base64 = mediaData.base64;
        const mimeType = mediaData.mimetype || 'audio/ogg';

        if (!base64) throw new Error('Base64 não retornado');

        const parsed = await parseAudio(base64, mimeType);
        console.log('Audio parsed:', JSON.stringify(parsed));
        if (parsed.encontrou && parsed.valor > 0) {
          const respMsg = await salvarTransacao(parsed, from);
          if (parsed.transcricao) await sendWhatsApp(from, `💬 _"${parsed.transcricao}"_`);
          await sendWhatsApp(from, respMsg);
        } else {
          const transcricao = parsed.transcricao || 'Não foi possível transcrever';
          await sendWhatsApp(from, `💬 Transcrição: _"${transcricao}"_\n\n🤔 Não identifiquei um gasto. Tente ser mais específico, ex: "gastei 50 de gasolina"`);
        }
      } catch(e) {
        console.error('Audio error:', e.message);
        await sendWhatsApp(from, '❌ Não consegui processar o áudio. Tente enviar uma mensagem de texto.');
      }
      return;
    }

    // ── IMAGEM ──
    if (isImage) {
      await sendWhatsApp(from, '📸 Recebi a imagem! Analisando...');
      try {
        const mediaRes = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY },
          body: JSON.stringify({ message: msg.message, convertToMp4: false })
        });
        const mediaData = await mediaRes.json();
        const base64 = mediaData.base64;
        const mimeType = mediaData.mimetype || 'image/jpeg';

        if (!base64) throw new Error('Base64 não retornado');

        const parsed = await parseImage(base64, mimeType);
        console.log('Image parsed:', JSON.stringify(parsed));
        if (parsed.encontrou && parsed.valor > 0) {
          const respMsg = await salvarTransacao(parsed, from);
          await sendWhatsApp(from, respMsg);
        } else {
          await sendWhatsApp(from, '🤔 Não identifiquei um valor claro nessa imagem.\n\nTente enviar uma foto mais nítida do comprovante ou nota fiscal, ou me diga o valor em texto: "gastei R$X em Y"');
        }
      } catch(e) {
        console.error('Image error:', e.message);
        await sendWhatsApp(from, '❌ Não consegui analisar a imagem. Tente enviar em texto.');
      }
      return;
    }

    // ── COMANDOS DE TEXTO ──
    if (!body) return;

    if (['ajuda','help','oi','olá','ola','menu','start'].includes(lower)) {
      await sendWhatsApp(from,
        `💼 *Personal Finance PRO*\n` +
        `_Seu assistente financeiro pessoal_\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📥 *LANÇAR GASTOS*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 *Texto:*\n` +
        `• "30 gasolina carro"\n` +
        `• "mercado 120 hoje"\n` +
        `• "uber 25"\n\n` +
        `🎤 *Áudio:*\n` +
        `• Envie um áudio descrevendo o gasto\n\n` +
        `📸 *Foto/Comprovante:*\n` +
        `• Fotografe a nota fiscal ou comprovante\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *CONSULTAS*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• */resumo* — Visão do mês (salário - gastos)\n` +
        `• *saldo* — Quanto sobrou do orçamento\n` +
        `• *maiores gastos* — Top 5 categorias\n` +
        `• */parcelados* — Todas as parcelas em aberto\n` +
        `• */ultimos* — Lançamentos das últimas 24h\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `ℹ️ *AJUDA*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *ajuda* ou *menu* — Exibe este menu\n\n` +
        `_Personal Finance PRO — Suas finanças sob controle_ 💼`
      ); return;
    }

    if (lower.includes('/resumo') || lower.includes('resumo') || lower.includes('fluxo') || lower.includes('visão geral')) {
      const s = await getStats();
      const pct = s.totalIn > 0 ? ((s.liquido/s.totalIn)*100).toFixed(1) : 0;
      await sendWhatsApp(from,
        `📊 *Resumo do Mês — Personal Finance PRO*\n\n` +
        `💵 *Receita total:* ${fmt(s.totalIn)}\n` +
        `💳 *Gastos brutos:* ${fmt(s.bruto)}\n` +
        `✅ *Créditos/Estornos:* -${fmt(s.credTotal)}\n` +
        `💰 *Gastos líquidos:* ${fmt(s.liquido)}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏦 *Saldo disponível: ${fmt(s.saldo)}*\n` +
        `📈 Comprometido: ${pct}% da renda\n` +
        `📦 Total de lançamentos: ${s.txCount}\n\n` +
        `${s.saldo<0?'🔴 *Atenção:* Gastos acima da receita!':'🟢 Dentro do orçamento!'}`
      ); return;
    }

    if (lower.includes('saldo') || lower.includes('quanto tenho') || lower.includes('quanto sobrou') || lower.includes('quanto resta')) {
      const s = await getStats();
      await sendWhatsApp(from,
        `${s.saldo>=0?'🟢':'🔴'} *Saldo disponível: ${fmt(s.saldo)}*\n\n` +
        `💵 Renda total: ${fmt(s.totalIn)}\n` +
        `💳 Fatura: ${fmt(s.liquido)}\n\n` +
        `${s.saldo<0?'⚠️ Gastos acima da renda!':'✅ Dentro do orçamento!'}`
      ); return;
    }

    if (lower.includes('maiores gastos') || lower.includes('categorias') || lower.includes('onde gastei')) {
      const s = await getStats();
      const catsList = Object.entries(s.byCat).sort((a,b)=>b[1]-a[1]).slice(0,5);
      if (!catsList.length) { await sendWhatsApp(from,'📊 Nenhum gasto registrado ainda.'); return; }
      const emojis = { mercado:'🛒', automovel:'🚗', compras:'🛍️', assinatura:'📺', saude:'💊', transporte:'🚌', pet:'🐾', lazer:'🎉', servicos:'🔧', outros:'📝' };
      await sendWhatsApp(from,
        `📊 *Top categorias*\n\n` +
        catsList.map((c,i)=>`${i+1}. ${emojis[c[0]]||'📝'} ${getCatLabel(c[0])}: ${fmt(c[1])}`).join('\n') +
        `\n\n💳 Total: ${fmt(catsList.reduce((a,c)=>a+c[1],0))}`
      ); return;
    }

    if (lower.includes('/ultimos') || lower.includes('ultimos') || lower.includes('últimos') || lower.includes('ultimo') || lower.includes('último')) {
      const since = new Date(Date.now() - 24*60*60*1000).toISOString();
      const tx = await supabase('GET','transactions',null,`?select=*&order=created_at.desc&created_at=gte.${since}`);
      if (!Array.isArray(tx)||!tx.length) { await sendWhatsApp(from,'📝 Nenhum lançamento nas últimas 24 horas.'); return; }
      const emojisH = { Thiago:'👨', Leandra:'👩' };
      const linhas = tx.map(t =>
        `${emojisH[t.holder]||'👤'} *${t.holder}* — ${t.description}\n` +
        `   💰 ${fmt(t.value)} | 📂 ${getCatLabel(t.cat)} | 📅 ${t.date}`
      ).join('\n\n');
      await sendWhatsApp(from,
        `🕐 *Lançamentos — Últimas 24h*\n` +
        `_${tx.length} registro(s) encontrado(s)_\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        linhas +
        `\n━━━━━━━━━━━━━━━━━━━━\n` +
        `💳 *Total:* ${fmt(tx.reduce((a,t)=>a+parseFloat(t.value||0),0))}`
      ); return;
    }

    if (lower.includes('/parcelados') || lower.includes('parcelados') || lower.includes('parcelas')) {
      const tx = await supabase('GET','transactions',null,'?select=*&parc=not.is.null&order=description.asc');
      const parcelados = (Array.isArray(tx)?tx:[]).filter(t => t.parc && t.parc.includes('/'));
      if (!parcelados.length) { await sendWhatsApp(from,'✅ Nenhuma parcela em aberto no momento.'); return; }

      // Agrupar por descrição para mostrar progresso
      const grupos = {};
      parcelados.forEach(t => {
        const key = t.description.toLowerCase().trim();
        if (!grupos[key]) grupos[key] = { desc: t.description, cat: t.cat, holder: t.holder, parcelas: [], value: parseFloat(t.value||0) };
        grupos[key].parcelas.push(t.parc);
      });

      const emojisH = { Thiago:'👨', Leandra:'👩' };
      const linhas = Object.values(grupos).map(g => {
        const total = g.parcelas.length;
        // Pegar última parcela para saber o total
        const ultimaParc = g.parcelas[g.parcelas.length-1] || '?/?';
        const [atual, totalParc] = ultimaParc.split('/');
        const faltam = totalParc ? parseInt(totalParc) - parseInt(atual) : '?';
        return `${emojisH[g.holder]||'👤'} *${g.desc}*\n` +
               `   💰 ${fmt(g.value)}/parcela | 📊 ${ultimaParc} | ⏳ Faltam: ${faltam}`;
      }).join('\n\n');

      await sendWhatsApp(from,
        `💳 *Parcelas em Aberto*\n` +
        `_${Object.keys(grupos).length} item(s) parcelado(s)_\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        linhas +
        `\n━━━━━━━━━━━━━━━━━━━━`
      ); return;
    }

    // ── EXTRAIR GASTO POR TEXTO ──
    const parsed = await parseByText(body);
    console.log('Text parsed:', JSON.stringify(parsed));

    if (parsed.encontrou && parsed.valor > 0) {
      const respMsg = await salvarTransacao(parsed, from);
      await sendWhatsApp(from, respMsg);
    } else {
      const s = await getStats();
      let resposta = '';
      try {
        resposta = await askGemini([{ role:'user', parts:[{ text:
          `Você é o Personal Finance PRO, assistente financeiro pessoal do Sr. Thiago. ` +
          `Dados atuais: fatura=${fmt(s.liquido)}, saldo=${fmt(s.saldo)}, renda=${fmt(s.totalIn)}.\n` +
          `Mensagem do Sr. Thiago: "${body}"\n` +
          `Responda de forma formal e educada, em português, direto e objetivo, máximo 3 linhas. Use emojis.`
        }]}]);
      } catch(e) {}
      await sendWhatsApp(from, resposta || '💼 Não compreendi sua solicitação, Sr. Thiago. Digite *ajuda* para visualizar os comandos disponíveis.');
    }

  } catch(err) {
    console.error('Webhook error:', err);
  }
});

app.get('/', (req, res) => res.send('🤖 Bot Financeiro PRO rodando! ✅'));
app.get('/health', (req, res) => res.json({ status:'ok', version:'PRO-Evolution', time:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bot PRO (Evolution API) na porta ${PORT}`));
