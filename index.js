const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LVwgDeO2cuDnM6GivUOJ0Rh3S48HhXWf4WKPKItoqXgQ';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rtnnpwzclkcipwalbhjm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_b7bcdrIrWfoKt6golOQ1Iw_2y1DYkrh';

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

async function getStats() {
  const tx = await supabase('GET', 'transactions', null, '?select=*');
  const salaries = await supabase('GET', 'salaries', null, '?select=*');
  const entries = await supabase('GET', 'entries', null, '?select=*');
  const debitos = Array.isArray(tx) ? tx.filter(t => !t.is_credit) : [];
  const creditos = Array.isArray(tx) ? tx.filter(t => t.is_credit) : [];
  const bruto = debitos.reduce((a, t) => a + parseFloat(t.value || 0), 0);
  const credTotal = creditos.reduce((a, t) => a + Math.abs(parseFloat(t.value || 0)), 0);
  const liquido = bruto - credTotal;
  const totalIn = (Array.isArray(salaries) ? salaries : []).reduce((a, s) => a + parseFloat(s.salary || 0), 0)
    + (Array.isArray(entries) ? entries : []).reduce((a, e) => a + parseFloat(e.value || 0), 0);
  const byCat = {};
  debitos.forEach(t => { byCat[t.cat] = (byCat[t.cat] || 0) + parseFloat(t.value || 0); });
  return { bruto, credTotal, liquido, totalIn, saldo: totalIn - liquido, byCat, txCount: debitos.length };
}

async function askGemini(prompt) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.1 }
    })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function parseTransaction(msg) {
  const prompt = `Analise esta mensagem e extraia informações de gasto financeiro.
Mensagem: "${msg}"

Retorne APENAS JSON sem markdown:
{"encontrou": true, "valor": 0.00, "descricao": "nome do produto ou local", "categoria": "mercado|automovel|compras|assinatura|saude|transporte|pet|lazer|servicos|outros", "data": "YYYY-MM-DD"}

Se não encontrar um gasto claro, retorne: {"encontrou": false}
Data de hoje: ${new Date().toISOString().slice(0, 10)}
Exemplos de gastos: "gastei 50 de gasolina", "mercado 120 reais", "paguei 30 no almoço"`;

  const resp = await askGemini(prompt);
  try {
    return JSON.parse(resp.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { encontrou: false };
  }
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

const fmt = v => 'R$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const emojis = { mercado:'🛒', automovel:'🚗', compras:'🛍️', assinatura:'📺', saude:'💊', transporte:'🚌', pet:'🐾', lazer:'🎉', servicos:'🔧', outros:'📝' };

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const lower = body.toLowerCase();

  if (!from || !body) return;

  try {
    // Menu de ajuda
    if (lower === 'ajuda' || lower === 'help' || lower === 'oi' || lower === 'menu') {
      await sendWhatsApp(from,
        `🤖 *Assistente Financeiro*\n\n` +
        `💬 *Lançar gasto:*\n"Gastei R$50 de gasolina"\n"Mercado R$120 hoje"\n"Paguei 80 no almoço"\n\n` +
        `📊 *Consultas:*\n"Resumo"\n"Saldo"\n"Maiores gastos"\n\n` +
        `_Pode escrever naturalmente!_ 😊`
      );
      return;
    }

    // Resumo financeiro
    if (lower.includes('resumo') || lower.includes('fluxo') || lower.includes('saldo') || lower.includes('quanto tenho')) {
      const s = await getStats();
      await sendWhatsApp(from,
        `📊 *Resumo financeiro*\n\n` +
        `💳 Fatura bruta: ${fmt(s.bruto)}\n` +
        `✅ Créditos: -${fmt(s.credTotal)}\n` +
        `💰 Fatura líquida: ${fmt(s.liquido)}\n\n` +
        `💵 Renda total: ${fmt(s.totalIn)}\n` +
        `🏦 Saldo disponível: ${fmt(s.saldo)}\n\n` +
        `📦 Lançamentos: ${s.txCount}`
      );
      return;
    }

    // Maiores gastos por categoria
    if (lower.includes('categorias') || lower.includes('maiores gastos') || lower.includes('onde gastei')) {
      const s = await getStats();
      const cats = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (!cats.length) {
        await sendWhatsApp(from, '📊 Nenhum gasto registrado ainda.');
        return;
      }
      const lista = cats.map((c, i) => `${i + 1}. ${emojis[c[0]] || '📝'} ${c[0]}: ${fmt(c[1])}`).join('\n');
      await sendWhatsApp(from, `📊 *Maiores gastos por categoria*\n\n${lista}`);
      return;
    }

    // Tentar extrair lançamento da mensagem
    const parsed = await parseTransaction(body);

    if (parsed.encontrou && parsed.valor > 0) {
      const phoneLeandra = process.env.PHONE_LEANDRA || '';
      const holder = phoneLeandra && from.includes(phoneLeandra) ? 'Leandra' : 'Thiago';

      await supabase('POST', 'transactions', {
        date: parsed.data,
        description: parsed.descricao,
        value: parsed.valor,
        holder: holder,
        cat: parsed.categoria,
        parc: null,
        obs: `Via WhatsApp (${from})`,
        is_credit: false
      });

      const emoji = emojis[parsed.categoria] || '📝';
      await sendWhatsApp(from,
        `${emoji} *Lançado com sucesso!*\n\n` +
        `📝 ${parsed.descricao}\n` +
        `💰 ${fmt(parsed.valor)}\n` +
        `📂 ${parsed.categoria}\n` +
        `📅 ${parsed.data}\n` +
        `👤 ${holder}`
      );
    } else {
      // Resposta livre via IA
      const s = await getStats();
      const context = `Você é um assistente financeiro pessoal. Dados: fatura=${fmt(s.liquido)}, saldo=${fmt(s.saldo)}, renda=${fmt(s.totalIn)}. Responda em português, seja direto e amigável. Máx 3 linhas.`;
      const resposta = await askGemini(context + '\n\nMensagem do usuário: ' + body);
      await sendWhatsApp(from, resposta || 'Não entendi. Digite *ajuda* para ver os comandos. 😊');
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
    try {
      await sendWhatsApp(from, '❌ Ocorreu um erro. Tente novamente em instantes.');
    } catch (e) {}
  }
});

app.get('/', (req, res) => res.send('🤖 Bot Financeiro rodando! ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
