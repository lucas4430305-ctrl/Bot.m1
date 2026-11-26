// Backend de exemplo: loja de números virtuais usando a Hero SMS.
// Requisitos: Node 18+ e "npm i express".
// Variáveis de ambiente (arquivo .env ou painel da hospedagem):
//   HERO_API_KEY  = sua chave da Hero SMS (NUNCA coloque no front-end)
//   HERO_BASE_URL = endereço base da API, copie da documentação da Hero SMS
//                   (formato esperado: .../stubs/handler_api.php)
//   PORT          = 3000 (opcional)

const express = require("express");
const app = express();
app.use(express.json());
app.use(express.static("public")); // coloque o loja-sms.html aqui como index.html

const KEY = process.env.HERO_API_KEY;
const BASE = process.env.HERO_BASE_URL;
if (!KEY || !BASE) {
  console.error("Defina HERO_API_KEY e HERO_BASE_URL.");
  process.exit(1);
}

// Códigos de serviço e país no padrão SMS-Activate. CONFIRME na documentação da Hero SMS.
const SERVICES = { wa: "WhatsApp", tg: "Telegram", ig: "Instagram", fb: "Facebook", tt: "TikTok" };
const COUNTRIES = { 73: "Brasil", 187: "Estados Unidos", 16: "Reino Unido", 22: "Índia" };

// Seu preço de venda (R$) por serviço e país. Defina acima do seu custo.
const PRICE = (service, country) => 2.5 * (service === "wa" ? 1 : 1.1) * (country === 73 ? 1 : 1.5);
const MAX_COST_USD = 2; // teto que você aceita pagar ao fornecedor por número

// ATENÇÃO: isto é memória do processo, só para testar.
// Em produção use banco de dados + login (cada cliente com seu próprio saldo).
const wallets = { demo: 25 };
const orders = new Map();
const userOf = () => "demo"; // TODO: trocar por usuário autenticado

// Chamada à API do fornecedor. Respostas são texto, como "ACCESS_NUMBER:123:5511999999999".
async function hero(action, params = {}) {
  const url = new URL(BASE);
  url.search = new URLSearchParams({ api_key: KEY, action, ...params }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return (await res.text()).trim();
}

app.get("/api/balance", (req, res) => res.json({ balance: wallets[userOf(req)] }));

app.post("/api/order", async (req, res) => {
  const { service, country } = req.body;
  if (!SERVICES[service] || !COUNTRIES[country]) return res.status(400).json({ error: "Serviço ou país inválido." });

  const user = userOf(req);
  const price = PRICE(service, country);
  if (wallets[user] < price) return res.status(402).json({ error: "Saldo insuficiente." });

  const r = await hero("getNumber", { service, country, maxPrice: MAX_COST_USD });
  if (r.startsWith("ACCESS_NUMBER:")) {
    const [, id, phone] = r.split(":");
    wallets[user] -= price; // só cobra depois de receber o número
    orders.set(id, { id, user, phone, price, service, code: null, done: false, createdAt: Date.now() });
    await hero("setStatus", { id, status: 1 }); // avisa que o SMS foi solicitado
    return res.json({ id, phone, price });
  }
  const msgs = {
    NO_NUMBERS: "Sem números disponíveis agora. Tente outro país.",
    NO_BALANCE: "Estoque temporariamente indisponível.", // saldo seu no fornecedor acabou
    BAD_KEY: "Erro de configuração.",
  };
  console.error("getNumber falhou:", r);
  res.status(502).json({ error: msgs[r] || "Não foi possível obter o número." });
});

// O front-end chama esta rota a cada ~3 segundos.
app.get("/api/order/:id", async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o || o.user !== userOf(req)) return res.status(404).json({ error: "Pedido não encontrado." });
  if (o.code || o.done) return res.json({ status: o.done ? "done" : "ok", code: o.code });

  // Expira em 5 minutos e devolve o saldo ao cliente.
  if (Date.now() - o.createdAt > 5 * 60 * 1000) return res.json(await cancel(o));

  const r = await hero("getStatus", { id: o.id });
  if (r.startsWith("STATUS_OK:")) {
    o.code = r.split(":")[1];
    await hero("setStatus", { id: o.id, status: 6 }); // finaliza a ativação
    return res.json({ status: "ok", code: o.code });
  }
  if (r === "STATUS_CANCEL") return res.json(await refund(o));
  res.json({ status: "waiting" });
});

app.post("/api/order/:id/cancel", async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o || o.user !== userOf(req)) return res.status(404).json({ error: "Pedido não encontrado." });
  if (o.code) return res.status(400).json({ error: "O código já chegou." });
  res.json(await cancel(o));
});

async function cancel(o) {
  if (o.done) return { status: "cancelled" };
  const r = await hero("setStatus", { id: o.id, status: 8 });
  // Alguns fornecedores só permitem cancelar após alguns minutos.
  if (r.includes("EARLY_CANCEL_DENIED")) return { status: "waiting", error: "Aguarde um pouco para cancelar." };
  return refund(o);
}

function refund(o) {
  if (!o.done) {
    o.done = true;
    wallets[o.user] += o.price; // devolve o saldo uma única vez
  }
  return { status: "cancelled", balance: wallets[o.user] };
}

app.listen(process.env.PORT || 3000, () => console.log("Servidor no ar."));
