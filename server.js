const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = require("./package.json").version;
const DEFAULT_DATA_FILE = path.join(__dirname, "data", "make-money.json");
const DRAW_DURATION_MS = Number(process.env.DRAW_DURATION_MS) || 4500;
const SESSION_COOKIE = "mm_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_ITERATIONS = 210_000;
const RESET_CODE_LIFETIME_MS = 15 * 60 * 1000;
const RESET_CODE_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const MEMBERS = [
  { id: "member-1", name: "Ana" },
  { id: "member-2", name: "Bruno" },
  { id: "member-3", name: "Camila" },
  { id: "member-4", name: "Diego" },
  { id: "member-5", name: "Eduarda" },
  { id: "member-6", name: "Felipe" }
];

function createInitialState() {
  const createdAt = new Date().toISOString();
  return {
    version: 1,
    cycle: {
      id: "demo-cycle",
      number: 1,
      status: "active",
      contributionCents: 1000,
      roundContributionCents: Array(6).fill(1000),
      roundCount: 6,
      createdAt
    },
    cycleHistory: [],
    deletedHistoryRoundIds: [],
    participants: MEMBERS.map((member) => ({
      ...member,
      status: "active"
    })),
    wheelOrder: MEMBERS.map((member) => member.id),
    rounds: Array.from({ length: 6 }, (_, index) => ({
      id: `round-${index + 1}`,
      number: index + 1,
      cycleId: "demo-cycle",
      cycleNumber: 1,
      status: index === 0 ? "open" : "pending",
      prizeCents: 6000,
      winnerId: null,
      drawStartedAt: null,
      drawCompletedAt: null,
      tieCount: 0,
      spins: [],
      tiedParticipantIds: [],
      payments: MEMBERS.map((member) => ({
        userId: member.id,
        amountCents: 1000,
        status: "pending",
        adminConfirmed: false,
        confirmedAt: null
      }))
    })),
    authUsers: [],
    sessions: [],
    pixPayment: {
      copyPaste: "",
      qrCodeUrl: ""
    },
    audit: [{
      type: "cycle_created",
      at: createdAt,
      details: "Ciclo demonstrativo criado."
    }]
  };
}

function ensureMasterAdmin(state, options = {}) {
  for (const user of state.authUsers) {
    if (!user.role) user.role = "participant";
  }
  const admins = state.authUsers.filter((user) => user.role === "admin");
  if (admins.length > 1) throw new Error("Ha mais de uma conta de administrador mestre configurada.");

  const email = String(options.adminEmail || process.env.MASTER_ADMIN_EMAIL || "ericksanttos81@gmail.com").trim().toLowerCase();
  const configuredPassword = options.adminPassword || process.env.MASTER_ADMIN_PASSWORD;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("MASTER_ADMIN_EMAIL precisa conter um endereco de e-mail valido.");
  }
  if (admins.length === 1) {
    const admin = admins[0];
    if (state.authUsers.some((user) => user.id !== admin.id && user.email === email)) {
      throw new Error("O e-mail do administrador mestre ja esta usado por outra conta. Defina MASTER_ADMIN_EMAIL.");
    }
    const oldEmail = admin.email;
    admin.email = email;
    let passwordChanged = false;
    if (configuredPassword) {
      const currentHash = crypto.pbkdf2Sync(configuredPassword, admin.passwordSalt, PASSWORD_ITERATIONS, 32, "sha256");
      const savedHash = Buffer.from(admin.passwordHash, "hex");
      if (currentHash.length !== savedHash.length || !crypto.timingSafeEqual(currentHash, savedHash)) {
        const salt = crypto.randomBytes(16).toString("hex");
        admin.passwordSalt = salt;
        admin.passwordHash = crypto.pbkdf2Sync(configuredPassword, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
        state.sessions = state.sessions.filter((session) => session.userId !== admin.id);
        passwordChanged = true;
      }
    }
    if (oldEmail !== admin.email || passwordChanged) {
      state.audit.push({
        type: passwordChanged ? "master_admin_credentials_updated" : "master_admin_email_updated",
        at: new Date().toISOString(),
        userId: admin.id,
        details: passwordChanged
          ? "Credenciais do administrador mestre atualizadas."
          : "E-mail do administrador mestre atualizado pela configuracao do servidor."
      });
    }
    return null;
  }

  if (state.authUsers.some((user) => user.email === email)) {
    throw new Error("O e-mail do administrador mestre ja esta usado por outra conta. Defina MASTER_ADMIN_EMAIL.");
  }
  if (!configuredPassword) return null;

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.pbkdf2Sync(configuredPassword, salt, PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
  const admin = {
    id: crypto.randomUUID(),
    participantId: null,
    role: "admin",
    name: "Administrador Mestre",
    email,
    passwordSalt: salt,
    passwordHash,
    createdAt: new Date().toISOString()
  };
  state.authUsers.push(admin);
  state.audit.push({
    type: "master_admin_created",
    at: admin.createdAt,
    userId: admin.id,
    details: "Conta de administrador mestre configurada."
  });
  return null;
}

function setMasterAdminPassword(password, options = {}) {
  if (typeof password !== "string" || password.length === 0 || password.length > 128) {
    throw new Error("A senha precisa conter entre 1 e 128 caracteres.");
  }
  const filePath = options.dataFile || DEFAULT_DATA_FILE;
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!options.supabaseClient && Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para habilitar a persistencia no Supabase.");
  }
  if (!options.supabaseClient && supabaseServiceRoleKey?.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY precisa ser uma chave secreta de servidor, nao uma chave publishable.");
  }
  if (options.supabaseClient || supabaseUrl) {
    return (async () => {
      const supabase = options.supabaseClient || createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
      const { data, error } = await supabase.from("app_state").select("payload").eq("id", "main").maybeSingle();
      if (error) throw new Error(`Falha ao carregar os dados do Supabase: ${error.message}`);
      const state = data
        ? normalizeState(data.payload, "Supabase app_state")
        : fs.existsSync(filePath) ? readState(filePath) : createInitialState();
      ensureMasterAdmin(state, {
        adminEmail: options.adminEmail,
        adminPassword: password
      });
      const { error: saveError } = await supabase.from("app_state").upsert({
        id: "main",
        payload: state,
        updated_at: new Date().toISOString()
      });
      if (saveError) throw new Error(`Falha ao salvar os dados no Supabase: ${saveError.message}`);
    })();
  }
  const state = readState(filePath);
  ensureMasterAdmin(state, {
    adminEmail: options.adminEmail,
    adminPassword: password
  });
  writeState(filePath, state);
}

function promptHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Este comando precisa ser executado em um terminal interativo."));
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Operacao cancelada."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0008" || character === "\u007f") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f" && value.length < 128) {
          value += character;
          process.stdout.write("*");
        }
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function normalizeState(parsed, filePath, persist = () => {}) {
  if (parsed.version !== 1 || !Array.isArray(parsed.participants) || !Array.isArray(parsed.rounds)) {
    throw new Error(`O arquivo de dados do Make Money esta invalido: ${filePath}`);
  }

  parsed.authUsers ||= [];
  parsed.sessions ||= [];
  parsed.cycleHistory ||= [];
  parsed.deletedHistoryRoundIds = Array.isArray(parsed.deletedHistoryRoundIds)
    ? [...new Set(parsed.deletedHistoryRoundIds.filter((roundId) => typeof roundId === "string"))]
    : [];
  parsed.pixPayment ||= { copyPaste: "", qrCodeUrl: "" };
  parsed.pixPayment.copyPaste = typeof parsed.pixPayment.copyPaste === "string" ? parsed.pixPayment.copyPaste : "";
  parsed.pixPayment.qrCodeUrl = typeof parsed.pixPayment.qrCodeUrl === "string" ? parsed.pixPayment.qrCodeUrl : "";
  parsed.cycle.number ||= 1;
  const currentCycleRounds = parsed.rounds.filter((round) => round.cycleId === parsed.cycle.id);
  if (!Array.isArray(parsed.cycle.roundContributionCents)
    || parsed.cycle.roundContributionCents.length !== parsed.cycle.roundCount
    || parsed.cycle.roundContributionCents.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) {
    parsed.cycle.roundContributionCents = Array.from({ length: parsed.cycle.roundCount }, (_, index) => {
      const round = currentCycleRounds.find((item) => item.number === index + 1);
      const amount = round?.payments?.[0]?.amountCents;
      return Number.isSafeInteger(amount) && amount > 0
        ? amount
        : parsed.cycle.contributionCents;
    });
  }
  parsed.cycle.contributionCents = parsed.cycle.roundContributionCents[0];
  for (const round of parsed.rounds) {
    round.cycleId ||= parsed.cycle.id;
    round.cycleNumber ||= parsed.cycle.number;
  }
  const savedWheelOrder = Array.isArray(parsed.wheelOrder) ? parsed.wheelOrder : [];
  parsed.wheelOrder = [
    ...savedWheelOrder.filter((id, index) =>
      parsed.participants.some((member) => member.id === id) && savedWheelOrder.indexOf(id) === index),
    ...parsed.participants.map((member) => member.id).filter((id) => !savedWheelOrder.includes(id))
  ];
  let recovered = false;
  for (const round of parsed.rounds) {
    if (!Array.isArray(round.spins)) round.spins = [];
    if (!Array.isArray(round.tiedParticipantIds)) round.tiedParticipantIds = [];
    if (!Number.isInteger(round.tieCount) || round.tieCount < 0) {
      round.tieCount = 0;
      recovered = true;
    }
    for (const payment of round.payments) {
      if (typeof payment.adminConfirmed !== "boolean") {
        payment.adminConfirmed = false;
        recovered = true;
      }
    }
    if (round.status === "ready" && !round.payments.every((payment) => payment.status === "confirmed" && payment.adminConfirmed)) {
      round.status = "open";
      recovered = true;
    }
    if (round.status === "tied") {
      const restartedAt = new Date().toISOString();
      round.tieCount += 1;
      parsed.audit.push({
        type: "draw_tie_restarted",
        at: restartedAt,
        roundId: round.id,
        attempt: round.tieCount,
        tiedParticipantIds: [...round.tiedParticipantIds],
        spins: round.spins.map((spin) => ({ ...spin })),
        details: "Empate recuperado de uma versao anterior; os giros foram reiniciados automaticamente."
      });
      round.status = round.payments.every((payment) => payment.status === "confirmed" && payment.adminConfirmed)
        ? "ready"
        : "open";
      round.winnerId = null;
      round.drawStartedAt = null;
      round.drawCompletedAt = null;
      round.spins = [];
      round.tiedParticipantIds = [];
      recovered = true;
    }
  }
  for (const round of parsed.rounds) {
    if (round.status === "drawing") {
      round.status = "completed";
      round.drawCompletedAt = new Date().toISOString();
      parsed.audit.push({
        type: "draw_recovered",
        at: round.drawCompletedAt,
        roundId: round.id,
        details: "Sorteio finalizado na recuperacao do servidor."
      });
      recovered = true;
    }
  }
  if (completeCurrentCycle(parsed)) recovered = true;
  if (recovered) {
    openNextRound(parsed);
    persist(filePath, parsed);
  }
  return parsed;
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) {
    const initial = createInitialState();
    writeState(filePath, initial);
    return initial;
  }

  return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath, writeState);
}

function openNextRound(state) {
  const nextRound = state.rounds.find((round) =>
    round.cycleId === state.cycle.id && round.status === "pending");
  if (nextRound) nextRound.status = "open";
}

function getCurrentRound(state) {
  return state.rounds.find((round) =>
    round.cycleId === state.cycle.id && round.status !== "completed" && round.status !== "cancelled") || null;
}

function createCycleRounds(cycle) {
  return Array.from({ length: cycle.roundCount }, (_, index) => ({
    id: `${cycle.id}-round-${index + 1}`,
    number: index + 1,
    cycleId: cycle.id,
    cycleNumber: cycle.number,
    status: index === 0 ? "open" : "pending",
    prizeCents: cycle.roundContributionCents[index] * MEMBERS.length,
    winnerId: null,
    drawStartedAt: null,
    drawCompletedAt: null,
    tieCount: 0,
    spins: [],
    tiedParticipantIds: [],
    payments: MEMBERS.map((member) => ({
      userId: member.id,
      amountCents: cycle.roundContributionCents[index],
      status: "pending",
      adminConfirmed: false,
      confirmedAt: null
    }))
  }));
}

function completeCurrentCycle(state) {
  if (state.cycle.status === "completed") return false;
  const currentRounds = state.rounds.filter((round) => round.cycleId === state.cycle.id);
  if (currentRounds.length < state.cycle.roundCount
    || !currentRounds.every((round) => round.status === "completed")) return false;

  const completedAt = new Date().toISOString();
  state.cycle = { ...state.cycle, status: "completed", completedAt };
  state.cycleHistory.push({ ...state.cycle });
  state.audit.push({
    type: "cycle_completed",
    at: completedAt,
    cycleId: state.cycle.id,
    details: "As seis rodadas do ciclo foram concluídas."
  });
  return true;
}

function startNextCycle(state) {
  if (state.cycle.status !== "completed") return false;
  const startedAt = new Date().toISOString();
  const nextCycleNumber = state.cycle.number + 1;
  state.cycle = {
    id: `cycle-${nextCycleNumber}`,
    number: nextCycleNumber,
    status: "active",
    contributionCents: state.cycle.contributionCents,
    roundContributionCents: [...state.cycle.roundContributionCents],
    roundCount: state.cycle.roundCount,
    createdAt: startedAt
  };
  state.rounds.push(...createCycleRounds(state.cycle));
  state.audit.push({
    type: "cycle_renewed",
    at: startedAt,
    cycleId: state.cycle.id,
    details: `Ciclo ${nextCycleNumber} iniciado pelo administrador.`
  });
  return true;
}

function getPublicState(state) {
  const currentRound = getCurrentRound(state);
  const rounds = state.rounds.map((round) => ({
    ...round,
    winnerId: round.status === "drawing" ? null : round.winnerId,
    payments: round.payments.map((payment) => ({ ...payment }))
  }));
  const latestResult = [...state.rounds].reverse().find((round) =>
    round.cycleId === state.cycle.id && round.status === "completed") || null;
  const deletedHistoryRoundIds = new Set(state.deletedHistoryRoundIds);
  const history = state.rounds
    .filter((round) => round.status === "completed" && !deletedHistoryRoundIds.has(round.id))
    .map((round) => ({
      id: round.id,
      number: round.number,
      cycleId: round.cycleId,
      cycleNumber: round.cycleNumber,
      winnerId: round.winnerId,
      prizeCents: round.prizeCents
    }));

  const registeredParticipantIds = new Set(state.authUsers
    .filter((user) => user.role !== "admin" && user.participantId)
    .map((user) => user.participantId));

  return {
    cycle: { ...state.cycle },
    cycleHistory: state.cycleHistory.map((cycle) => ({ ...cycle })),
    participants: state.participants.map((member) => ({
      ...member,
      registered: registeredParticipantIds.has(member.id)
    })),
    wheelOrder: [...state.wheelOrder],
    rounds,
    history,
    pixPayment: {
      copyPaste: state.pixPayment?.copyPaste || "",
      qrCodeUrl: state.pixPayment?.qrCodeUrl || ""
    },
    currentRoundId: currentRound ? currentRound.id : null,
    currentRound: currentRound ? rounds.find((round) => round.id === currentRound.id) : null,
    latestResult: latestResult ? rounds.find((round) => round.id === latestResult.id) : null,
    audit: state.audit.slice(-30).reverse().map((entry) => ({ ...entry })),
    serverTime: new Date().toISOString()
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function isLocalAdminSetupRequest(request) {
  const address = (request.socket.remoteAddress || "").toLowerCase().replace(/^::ffff:/, "");
  if (address !== "127.0.0.1" && address !== "::1") return false;
  if (!request.headers.host) return false;
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function sendResetEmailWithResend({ email, name, code }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Configure RESEND_API_KEY e RESEND_FROM_EMAIL para habilitar a recuperacao por e-mail.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Seu codigo para redefinir a senha do Make Money",
      html: `<div style="font-family:Arial,sans-serif;color:#252945;line-height:1.6"><h2>Ola, ${escapeHtml(name)}</h2><p>Use este codigo para redefinir sua senha:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#7053dc">${code}</p><p>O codigo expira em 15 minutos e so pode ser usado uma vez. Se voce nao solicitou a alteracao, ignore este e-mail.</p></div>`,
      text: `Ola, ${name}. Seu codigo de recuperacao do Make Money e ${code}. Ele expira em 15 minutos e so pode ser usado uma vez. Se voce nao solicitou a alteracao, ignore este e-mail.`
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend respondeu com HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error("A solicitacao excedeu o tamanho permitido."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("O corpo da solicitacao precisa ser JSON valido."));
      }
    });
    request.on("error", reject);
  });
}

function createApp(options = {}) {
  const filePath = options.dataFile || DEFAULT_DATA_FILE;
  const drawDurationMs = options.drawDurationMs ?? DRAW_DURATION_MS;
  const randomInt = options.randomInt || crypto.randomInt;
  const sendResetCodeEmail = options.sendResetCodeEmail || sendResetEmailWithResend;
  const resetCodeSecret = options.resetCodeSecret || process.env.PASSWORD_RESET_SECRET || process.env.RESEND_API_KEY;
  const now = options.now || Date.now;
  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!options.supabaseClient && Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para habilitar a persistencia no Supabase.");
  }
  if (!options.supabaseClient && supabaseServiceRoleKey?.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY precisa ser uma chave secreta de servidor, nao uma chave publishable.");
  }
  const supabase = options.supabaseClient || (supabaseUrl
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
    : null);
  const state = supabase ? createInitialState() : readState(filePath);
  const clients = new Map();
  const drawTimers = new Map();
  const resetRequestTimes = new Map();
  let closed = false;
  let persistenceQueue = Promise.resolve();

  function saveState() {
    const snapshot = structuredClone(state);
    const persist = async () => {
      if (!supabase) {
        writeState(filePath, snapshot);
        return;
      }
      const { error } = await supabase.from("app_state").upsert({
        id: "main",
        payload: snapshot,
        updated_at: new Date().toISOString()
      });
      if (error) throw new Error(`Falha ao salvar os dados no Supabase: ${error.message}`);
    };
    const pending = persistenceQueue.then(persist);
    persistenceQueue = pending.catch(() => {});
    return pending;
  }

  async function initializeState() {
    if (supabase) {
      const { data, error } = await supabase
        .from("app_state")
        .select("payload")
        .eq("id", "main")
        .maybeSingle();
      if (error) throw new Error(`Falha ao carregar os dados do Supabase: ${error.message}`);

      const initialState = data
        ? normalizeState(data.payload, "Supabase app_state")
        : fs.existsSync(filePath) ? readState(filePath) : createInitialState();
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, initialState);
    }
    state.sessions = state.sessions.filter((session) => session.expiresAt > Date.now());
    ensureMasterAdmin(state, options);
    await saveState();
    for (const round of state.rounds) {
      if (round.status !== "drawing" || drawTimers.has(round.id)) continue;
      const remaining = Math.max(0, drawDurationMs - (Date.now() - Date.parse(round.drawStartedAt)));
      scheduleDrawCompletion(round.id, remaining);
    }
  }

  const ready = initializeState();

  async function persistAndBroadcast() {
    await saveState();
    for (const [client, context] of clients) {
      if (client.destroyed) continue;
      const sessionIsActive = state.sessions.some((session) =>
        session.tokenHash === context.tokenHash && session.expiresAt > Date.now());
      if (!sessionIsActive) {
        clients.delete(client);
        client.end();
        continue;
      }
      const payload = getPublicState(state);
      if (context.role === "admin") {
        payload.participantAccounts = state.authUsers
          .filter((user) => user.role !== "admin")
          .map((user) => ({
            participantId: user.participantId,
            name: user.name,
            email: user.email,
            pixKey: user.pixKey || ""
          }));
      }
      client.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function parseCookies(request) {
    const cookies = {};
    for (const part of (request.headers.cookie || "").split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    }
    return cookies;
  }

  function findSession(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = state.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now());
    if (!session) return null;
    const user = state.authUsers.find((item) => item.id === session.userId);
    return user ? { session, user } : null;
  }

  function publicUser(user) {
    return {
      id: user.id,
      participantId: user.participantId,
      role: user.role || "participant",
      name: user.name,
      email: user.email
    };
  }

  function setSessionCookie(response, token, request, rememberMe) {
    const secure = Boolean(request.socket.encrypted);
    const maxAge = rememberMe ? `; Max-Age=${SESSION_LIFETIME_MS / 1000}` : "";
    response.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${maxAge}${secure ? "; Secure" : ""}`);
  }

  function clearSessionCookie(response, request) {
    const secure = Boolean(request.socket.encrypted);
    response.setHeader("Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
  }

  async function createSession(user, request, response, rememberMe = false) {
    const token = crypto.randomBytes(32).toString("base64url");
    const session = {
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      expiresAt: Date.now() + SESSION_LIFETIME_MS
    };
    state.sessions = state.sessions.filter((item) => item.userId !== user.id);
    for (const [client, context] of clients) {
      if (context.userId === user.id) {
        clients.delete(client);
        client.end();
      }
    }
    state.sessions.push(session);
    await saveState();
    setSessionCookie(response, token, request, rememberMe);
    sendJson(response, 200, { user: publicUser(user) });
  }

  function isValidEmail(email) {
    return typeof email === "string" && email.length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, PASSWORD_ITERATIONS, 32, "sha256", (error, hash) => {
        if (error) return reject(error);
        resolve(hash.toString("hex"));
      });
    });
  }

  function hashResetCode(userId, code) {
    if (!resetCodeSecret) throw new Error("PASSWORD_RESET_SECRET ou RESEND_API_KEY nao configurada.");
    return crypto.createHmac("sha256", resetCodeSecret).update(`${userId}:${code}`).digest("hex");
  }

  function constantTimeHexEquals(left, right) {
    if (!/^[\da-f]{64}$/i.test(left || "") || !/^[\da-f]{64}$/i.test(right || "")) return false;
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  }

  async function finishDraw(roundId) {
    const round = state.rounds.find((item) => item.id === roundId);
    if (!round || round.status !== "drawing") return;
    round.status = "completed";
    round.drawCompletedAt = new Date().toISOString();
    state.audit.push({
      type: "draw_completed",
      at: round.drawCompletedAt,
      roundId,
      winnerId: round.winnerId,
      details: "Resultado confirmado pelo servidor."
    });
    if (!completeCurrentCycle(state)) openNextRound(state);
    drawTimers.delete(roundId);
    await persistAndBroadcast();
  }

  function scheduleDrawCompletion(roundId, delay) {
    drawTimers.set(roundId, setTimeout(() => {
      finishDraw(roundId).catch((error) => console.error("Falha ao persistir o resultado do sorteio:", error));
    }, delay));
  }

  for (const round of state.rounds) {
    if (round.status === "drawing") {
      const remaining = Math.max(0, drawDurationMs - (Date.now() - Date.parse(round.drawStartedAt)));
      scheduleDrawCompletion(round.id, remaining);
    }
  }

  async function handleApi(request, response, pathname) {
    if (request.method === "GET" && pathname === "/api/version") {
      return sendJson(response, 200, { version: APP_VERSION });
    }

    if (request.method === "GET" && pathname === "/api/auth/session") {
      const current = findSession(request);
      return sendJson(response, 200, {
        user: current ? publicUser(current.user) : null,
        setupRequired: !state.authUsers.some((user) => user.role === "admin")
      });
    }

    if (request.method === "POST" && pathname === "/api/auth/setup/admin") {
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }
      if (!isLocalAdminSetupRequest(request)) {
        return sendJson(response, 403, { error: "A configuracao inicial do administrador so pode ser feita neste computador, usando localhost." });
      }
      if (state.authUsers.some((user) => user.role === "admin")) {
        return sendJson(response, 409, { error: "A conta do Administrador Mestre ja foi configurada." });
      }

      const body = await readJson(request);
      const password = body.password;
      if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        return sendJson(response, 400, { error: "A senha do administrador deve ter entre 8 e 128 caracteres." });
      }
      if (body.confirmPassword !== password) {
        return sendJson(response, 400, { error: "As senhas nao conferem." });
      }

      ensureMasterAdmin(state, {
        adminEmail: options.adminEmail,
        adminPassword: password
      });
      const admin = state.authUsers.find((user) => user.role === "admin");
      state.audit.push({
        type: "master_admin_initial_setup",
        at: new Date().toISOString(),
        userId: admin.id,
        details: "Senha inicial do administrador configurada pelo navegador local."
      });
      await persistAndBroadcast();
      return await createSession(admin, request, response);
    }

    if (request.method === "POST" && (pathname === "/api/auth/password-reset/request" || pathname === "/api/auth/password-reset/confirm")) {
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }
      const body = await readJson(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!isValidEmail(email)) return sendJson(response, 400, { error: "Informe um e-mail valido." });

      if (pathname === "/api/auth/password-reset/request") {
        const nowTimestamp = now();
        for (const [requestedEmail, requestedAt] of resetRequestTimes) {
          if (nowTimestamp - requestedAt >= RESET_CODE_COOLDOWN_MS) resetRequestTimes.delete(requestedEmail);
        }
        const lastRequestAt = resetRequestTimes.get(email) || 0;
        if (nowTimestamp - lastRequestAt < RESET_CODE_COOLDOWN_MS) {
          return sendJson(response, 429, { error: "Aguarde um minuto antes de solicitar outro codigo." });
        }
        if (resetRequestTimes.size >= 10_000) {
          resetRequestTimes.delete(resetRequestTimes.keys().next().value);
        }
        resetRequestTimes.set(email, nowTimestamp);
        const user = state.authUsers.find((item) => item.email === email);
        if (!user) {
          return sendJson(response, 200, {
            message: "Se o e-mail estiver cadastrado, enviaremos um codigo de recuperacao."
          });
        }

        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        try {
          await sendResetCodeEmail({ email: user.email, name: user.name, code });
        } catch (error) {
          console.error("Falha ao enviar codigo de recuperacao pelo Resend:", error.message);
          resetRequestTimes.delete(email);
          return sendJson(response, 502, { error: "Nao foi possivel enviar o codigo agora. Tente novamente mais tarde." });
        }

        user.passwordReset = {
          codeHash: hashResetCode(user.id, code),
          expiresAt: nowTimestamp + RESET_CODE_LIFETIME_MS,
          attemptsRemaining: RESET_CODE_MAX_ATTEMPTS
        };
        await saveState();
        return sendJson(response, 200, {
          message: "Se o e-mail estiver cadastrado, enviaremos um codigo de recuperacao."
        });
      }

      const code = typeof body.code === "string" ? body.code.trim() : "";
      const newPassword = body.newPassword;
      if (!/^\d{6}$/.test(code)) return sendJson(response, 400, { error: "Informe o codigo de 6 digitos recebido por e-mail." });
      if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 128) {
        return sendJson(response, 400, { error: "A nova senha deve ter entre 6 e 128 caracteres." });
      }
      if (body.confirmPassword !== newPassword) {
        return sendJson(response, 400, { error: "As senhas nao conferem." });
      }

      const user = state.authUsers.find((item) => item.email === email);
      const reset = user?.passwordReset;
      if (!user || !reset || reset.expiresAt <= now() || reset.attemptsRemaining <= 0) {
        if (user && reset?.expiresAt <= now()) delete user.passwordReset;
        await saveState();
        return sendJson(response, 400, { error: "Codigo invalido ou expirado. Solicite um novo codigo." });
      }

      const submittedCodeHash = hashResetCode(user.id, code);
      if (!constantTimeHexEquals(submittedCodeHash, reset.codeHash)) {
        reset.attemptsRemaining -= 1;
        if (reset.attemptsRemaining <= 0) delete user.passwordReset;
        await saveState();
        return sendJson(response, 400, {
          error: reset.attemptsRemaining > 0
            ? `Codigo incorreto. Restam ${reset.attemptsRemaining} tentativas.`
            : "Codigo incorreto. Solicite um novo codigo."
        });
      }

      const passwordSalt = crypto.randomBytes(16).toString("hex");
      user.passwordHash = await hashPassword(newPassword, passwordSalt);
      user.passwordSalt = passwordSalt;
      delete user.passwordReset;
      state.sessions = state.sessions.filter((session) => session.userId !== user.id);
      for (const [client, userId] of clients) {
        if (userId === user.id) {
          clients.delete(client);
          client.end();
        }
      }
      resetRequestTimes.delete(email);
      state.audit.push({
        type: "account_password_reset",
        at: new Date().toISOString(),
        userId: user.id,
        details: "Senha redefinida com codigo de recuperacao por e-mail."
      });
      await saveState();
      return sendJson(response, 200, { message: "Senha alterada. Entre com sua nova senha." });
    }

    if (request.method === "POST" && (pathname === "/api/auth/signup" || pathname === "/api/auth/signin" || pathname === "/api/auth/logout")) {
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }

      if (pathname === "/api/auth/logout") {
        const current = findSession(request);
        if (current) {
          state.sessions = state.sessions.filter((item) => item.tokenHash !== current.session.tokenHash);
          for (const [client, context] of clients) {
            if (context.userId === current.user.id) {
              clients.delete(client);
              client.end();
            }
          }
          await saveState();
        }
        clearSessionCookie(response, request);
        return sendJson(response, 200, { user: null });
      }

      const body = await readJson(request);
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!isValidEmail(email)) return sendJson(response, 400, { error: "Informe um e-mail valido." });

      if (pathname === "/api/auth/signup") {
        const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
        const password = body.password;
        const pixKey = typeof body.pixKey === "string" ? body.pixKey.trim() : "";
        if (name.length < 2 || name.length > 80) {
          return sendJson(response, 400, { error: "Informe seu nome completo (de 2 a 80 caracteres)." });
        }
        if (typeof body.pixKey !== "undefined" && (typeof body.pixKey !== "string" || pixKey.length > 254)) {
          return sendJson(response, 400, { error: "A chave Pix deve conter no maximo 254 caracteres." });
        }
        if (typeof password !== "string" || password.length < 6 || password.length > 128) {
          return sendJson(response, 400, { error: "A senha deve ter entre 6 e 128 caracteres." });
        }
        if (body.confirmPassword !== password) {
          return sendJson(response, 400, { error: "As senhas nao conferem." });
        }
        const adminEmail = String(options.adminEmail || process.env.MASTER_ADMIN_EMAIL || "ericksanttos81@gmail.com").trim().toLowerCase();
        if (state.authUsers.some((user) => user.email === email) || (!state.authUsers.some((user) => user.role === "admin") && email === adminEmail)) {
          return sendJson(response, 409, { error: "Este e-mail ja esta cadastrado." });
        }
        const participantAccounts = state.authUsers.filter((user) => user.role !== "admin");
        if (participantAccounts.length >= state.participants.length) {
          return sendJson(response, 409, { error: "As seis vagas do grupo ja possuem conta. Fale com o responsavel pelo grupo." });
        }

        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = await hashPassword(password, salt);
        if (state.authUsers.some((item) => item.email === email)) {
          return sendJson(response, 409, { error: "Este e-mail ja esta cadastrado." });
        }
        const claimedParticipants = new Set(state.authUsers.filter((item) => item.role !== "admin").map((item) => item.participantId));
        const participant = state.participants.find((item) => !claimedParticipants.has(item.id));
        if (!participant) {
          return sendJson(response, 409, { error: "As seis vagas do grupo ja possuem conta. Fale com o responsavel pelo grupo." });
        }
        const user = {
          id: crypto.randomUUID(),
          participantId: participant.id,
          role: "participant",
          name,
          email,
          pixKey,
          passwordSalt: salt,
          passwordHash,
          createdAt: new Date().toISOString()
        };
        participant.name = name;
        state.authUsers.push(user);
        state.audit.push({
          type: "participant_account_created",
          at: user.createdAt,
          userId: user.id,
          participantId: participant.id,
          details: "Conta de participante criada."
        });
        await persistAndBroadcast();
        return await createSession(user, request, response);
      }

      const user = state.authUsers.find((item) => item.email === email);
      const submittedHash = Buffer.from(await hashPassword(
        typeof body.password === "string" ? body.password : "",
        user ? user.passwordSalt : "00".repeat(16)
      ), "hex");
      const storedHash = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(0);
      if (!user || submittedHash.length !== storedHash.length || !crypto.timingSafeEqual(submittedHash, storedHash)) {
        return sendJson(response, 401, { error: "E-mail ou senha incorretos." });
      }
      return await createSession(user, request, response, body.rememberMe === true || body.rememberMe === "on");
    }

    const current = findSession(request);
    if (!current) return sendJson(response, 401, { error: "Sua sessao expirou. Entre novamente para continuar." });

    if (request.method === "GET" && pathname === "/api/admin/overview") {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode acessar o painel de administracao." });
      }
      const currentRound = getCurrentRound(state);
      const confirmedCount = currentRound
        ? currentRound.payments.filter((payment) => payment.status === "confirmed" && payment.adminConfirmed).length
        : 0;
      return sendJson(response, 200, {
        ...getPublicState(state),
        confirmedCount,
        participantAccounts: state.authUsers
          .filter((user) => user.role !== "admin")
          .map((user) => ({
            participantId: user.participantId,
            name: user.name,
            email: user.email,
            pixKey: user.pixKey || ""
          }))
      });
    }

    const adminHistoryMatch = pathname.match(/^\/api\/admin\/history\/([^/]+)$/);
    if (request.method === "DELETE" && adminHistoryMatch) {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode excluir registros do historico." });
      }
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }

      const roundId = adminHistoryMatch[1];
      const round = state.rounds.find((item) => item.id === roundId && item.status === "completed");
      if (!round || state.deletedHistoryRoundIds.includes(roundId)) {
        return sendJson(response, 404, { error: "Registro de sorteio nao encontrado no historico." });
      }

      state.deletedHistoryRoundIds.push(roundId);
      state.audit.push({
        type: "history_round_deleted",
        at: new Date().toISOString(),
        actorUserId: current.user.id,
        roundId,
        details: `Registro do sorteio do ciclo ${round.cycleNumber}, mes ${round.number}, removido do historico pelo administrador.`
      });
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    if (request.method === "POST" && pathname === "/api/admin/cycles/round-values") {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode configurar os valores das rodadas." });
      }
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }
      if (state.cycle.status !== "active") {
        return sendJson(response, 409, { error: "Os valores so podem ser configurados no ciclo ativo." });
      }

      const body = await readJson(request);
      const amounts = body.roundContributionCents;
      if (!Array.isArray(amounts)
        || amounts.length !== state.cycle.roundCount
        || amounts.some((amount) =>
          !Number.isSafeInteger(amount) || amount <= 0 || amount > Math.floor(Number.MAX_SAFE_INTEGER / MEMBERS.length))) {
        return sendJson(response, 400, { error: "Informe um valor em centavos, maior que zero, para cada uma das seis rodadas." });
      }

      const rounds = Array.from({ length: state.cycle.roundCount }, (_, index) =>
        state.rounds.find((round) => round.cycleId === state.cycle.id && round.number === index + 1));
      if (rounds.some((round) => !round)) {
        return sendJson(response, 409, { error: "Nao foi possivel localizar todas as rodadas do ciclo ativo." });
      }
      const lockedRounds = rounds.filter((round, index) => {
        const locked = round.status === "completed"
          || round.status === "cancelled"
          || round.spins.length > 0
          || round.payments.some((payment) => payment.status !== "pending" || payment.adminConfirmed);
        return locked && amounts[index] !== state.cycle.roundContributionCents[index];
      });
      if (lockedRounds.length) {
        return sendJson(response, 409, {
          error: `O valor do mês ${lockedRounds[0].number} nao pode ser alterado depois que o pagamento ou giro comecou.`
        });
      }

      state.cycle.roundContributionCents = [...amounts];
      state.cycle.contributionCents = amounts[0];
      for (const [index, round] of rounds.entries()) {
        if (round.status === "completed"
          || round.status === "cancelled"
          || round.spins.length > 0
          || round.payments.some((payment) => payment.status !== "pending" || payment.adminConfirmed)) continue;
        round.prizeCents = amounts[index] * MEMBERS.length;
        for (const payment of round.payments) payment.amountCents = amounts[index];
      }
      state.audit.push({
        type: "cycle_round_values_updated",
        at: new Date().toISOString(),
        actorUserId: current.user.id,
        cycleId: state.cycle.id,
        roundContributionCents: [...amounts],
        details: "Valores das contribuicoes atualizados pelo administrador mestre."
      });
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    if (request.method === "POST" && pathname === "/api/admin/pix-payment") {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode configurar os dados de pagamento Pix." });
      }
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }

      const body = await readJson(request);
      const copyPaste = typeof body.copyPaste === "string" ? body.copyPaste.trim() : null;
      const qrCodeUrl = typeof body.qrCodeUrl === "string" ? body.qrCodeUrl.trim() : null;
      if (copyPaste === null || copyPaste.length > 5000) {
        return sendJson(response, 400, { error: "Informe um Pix Copia e Cola valido com ate 5000 caracteres." });
      }
      if (qrCodeUrl === null || qrCodeUrl.length > 2048) {
        return sendJson(response, 400, { error: "Informe o link do QR Code com ate 2048 caracteres." });
      }
      if (qrCodeUrl) {
        let parsedQrCodeUrl;
        try {
          parsedQrCodeUrl = new URL(qrCodeUrl);
        } catch {
          return sendJson(response, 400, { error: "O link do QR Code precisa ser um endereco HTTP ou HTTPS valido." });
        }
        if (!["http:", "https:"].includes(parsedQrCodeUrl.protocol)) {
          return sendJson(response, 400, { error: "O link do QR Code precisa usar HTTP ou HTTPS." });
        }
      }

      state.pixPayment = { copyPaste, qrCodeUrl };
      state.audit.push({
        type: "pix_payment_settings_updated",
        at: new Date().toISOString(),
        actorUserId: current.user.id,
        details: "Dados de pagamento Pix atualizados pelo administrador mestre."
      });
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    const adminParticipantAccountMatch = pathname.match(/^\/api\/admin\/participants\/(member-[1-6])$/);
    if (request.method === "DELETE" && adminParticipantAccountMatch) {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode excluir contas de participantes." });
      }
      if (request.headers.origin && request.headers.host && new URL(request.headers.origin).host !== request.headers.host) {
        return sendJson(response, 403, { error: "Origem da solicitacao invalida." });
      }

      const participantId = adminParticipantAccountMatch[1];
      const participant = state.participants.find((item) => item.id === participantId);
      const accountIndex = state.authUsers.findIndex((user) =>
        user.role !== "admin" && user.participantId === participantId);
      if (!participant || accountIndex < 0) {
        return sendJson(response, 404, { error: "Nao ha uma conta cadastrada para este participante." });
      }

      const [account] = state.authUsers.splice(accountIndex, 1);
      state.sessions = state.sessions.filter((session) => session.userId !== account.id);
      for (const [client, context] of clients) {
        if (context.userId === account.id) {
          clients.delete(client);
          client.end();
        }
      }
      resetRequestTimes.delete(account.email);
      participant.name = MEMBERS.find((member) => member.id === participantId).name;
      state.audit = state.audit.filter((entry) =>
        entry.userId !== account.id && entry.actorUserId !== account.id && entry.requestedBy !== account.id);
      state.audit.push({
        type: "participant_account_deleted",
        at: new Date().toISOString(),
        participantId,
        actorUserId: current.user.id,
        details: "Conta e perfil do participante removidos pelo administrador mestre."
      });
      await persistAndBroadcast();
      return sendJson(response, 200, {
        ...getPublicState(state),
        participantAccounts: state.authUsers
          .filter((user) => user.role !== "admin")
          .map((user) => ({
            participantId: user.participantId,
            name: user.name,
            email: user.email,
            pixKey: user.pixKey || ""
          }))
      });
    }

    if (request.method === "POST" && pathname === "/api/admin/cycles/renew") {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode iniciar um novo ciclo." });
      }
      if (!startNextCycle(state)) {
        return sendJson(response, 409, { error: "O ciclo atual ainda nao foi concluido." });
      }
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    if (request.method === "POST" && pathname === "/api/admin/roulette/participants") {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode editar os participantes da roleta." });
      }
      const currentRound = getCurrentRound(state);
      if (currentRound?.spins?.length || currentRound?.tieCount > 0) {
        return sendJson(response, 409, { error: "Os nomes e a ordem ficam bloqueados depois do primeiro giro da rodada." });
      }

      const body = await readJson(request);
      if (!Array.isArray(body.participants) || body.participants.length !== state.participants.length) {
        return sendJson(response, 400, { error: "Informe os seis participantes para salvar os ajustes da roleta." });
      }
      const submittedIds = new Set();
      const submittedPositions = new Set();
      const changes = [];
      for (const item of body.participants) {
        if (!item || typeof item !== "object") {
          return sendJson(response, 400, { error: "Cada participante precisa ter nome e posicao validos." });
        }
        const participant = state.participants.find((member) => member.id === item.id);
        const name = typeof item.name === "string" ? item.name.trim().replace(/\s+/g, " ") : "";
        if (!participant || submittedIds.has(item.id)) {
          return sendJson(response, 400, { error: "A lista precisa conter cada participante uma unica vez." });
        }
        if (name.length < 2 || name.length > 80) {
          return sendJson(response, 400, { error: "Cada nome deve conter entre 2 e 80 caracteres." });
        }
        if (!Number.isInteger(item.position) || item.position < 1 || item.position > state.participants.length || submittedPositions.has(item.position)) {
          return sendJson(response, 400, { error: "Defina uma posicao unica de 1 a 6 para cada fatia da roleta." });
        }
        submittedIds.add(item.id);
        submittedPositions.add(item.position);
        changes.push({ participant, name, position: item.position });
      }

      const previousOrder = [...state.wheelOrder];
      const updatedOrder = [...changes].sort((a, b) => a.position - b.position).map(({ participant }) => participant.id);
      const changedParticipants = [];
      for (const { participant, name, position } of changes) {
        const previousName = participant.name;
        const previousPosition = previousOrder.indexOf(participant.id) + 1;
        if (previousName !== name || previousPosition !== position) {
          participant.name = name;
          const account = state.authUsers.find((user) => user.role !== "admin" && user.participantId === participant.id);
          if (account) account.name = name;
          changedParticipants.push({ id: participant.id, previousName, name, previousPosition, position });
        }
      }
      if (changedParticipants.length) {
        state.wheelOrder = updatedOrder;
        state.audit.push({
          type: "roulette_participant_updated_by_admin",
          at: new Date().toISOString(),
          actorUserId: current.user.id,
          changes: changedParticipants,
          details: "Nome ou posicao da fatia da roleta atualizado pelo administrador mestre."
        });
        await persistAndBroadcast();
      }
      return sendJson(response, 200, getPublicState(state));
    }

    const adminWinnerMatch = pathname.match(/^\/api\/admin\/rounds\/([^/]+)\/winner$/);
    if (request.method === "POST" && adminWinnerMatch) {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode alterar o sorteado." });
      }

      const [, roundId] = adminWinnerMatch;
      const round = state.rounds.find((item) => item.id === roundId);
      const currentRound = getCurrentRound(state);
      const latestCompletedRound = [...state.rounds].reverse().find((item) =>
        item.cycleId === state.cycle.id && item.status === "completed");
      if (!round || currentRound?.status === "drawing") {
        return sendJson(response, 409, { error: "Aguarde a roleta em andamento terminar antes de alterar o sorteado." });
      }
      const correctingLatestWinner = round.status === "completed" && round.id === latestCompletedRound?.id;
      if (!correctingLatestWinner) {
        return sendJson(response, 409, {
          error: currentRound?.id === round.id
            ? "O resultado sera definido automaticamente apos os seis giros."
            : "So e possivel ajustar o sorteado da rodada concluida mais recente."
        });
      }

      const body = await readJson(request);
      const winnerId = typeof body.winnerId === "string" ? body.winnerId : "";
      const participant = state.participants.find((item) => item.id === winnerId);
      const registeredParticipant = state.authUsers.some((user) => user.role !== "admin" && user.participantId === winnerId);
      if (!participant || !registeredParticipant) {
        return sendJson(response, 400, { error: "Selecione um participante valido para o sorteio." });
      }
      const alreadyWonAnotherRound = state.rounds.some((item) =>
        item.cycleId === round.cycleId
        && item.id !== round.id
        && item.status === "completed"
        && item.winnerId === winnerId);
      if (alreadyWonAnotherRound) {
        return sendJson(response, 409, { error: "Esse participante ja foi sorteado em outra rodada deste ciclo." });
      }
      if (round.winnerId !== winnerId) {
        const previousWinnerId = round.winnerId;
        round.winnerId = winnerId;
        const changedAt = new Date().toISOString();
        state.audit.push({
          type: "draw_winner_corrected_by_admin",
          at: changedAt,
          roundId,
          previousWinnerId,
          winnerId,
          actorUserId: current.user.id,
          details: "Ganhador oficial da rodada concluida atualizado pelo administrador mestre."
        });
        await persistAndBroadcast();
      }
      return sendJson(response, 200, getPublicState(state));
    }

    const adminPaymentMatch = pathname.match(/^\/api\/admin\/rounds\/([^/]+)\/payments\/(member-[1-6])$/);
    if (request.method === "POST" && adminPaymentMatch) {
      if (current.user.role !== "admin") {
        return sendJson(response, 403, { error: "Apenas o administrador mestre pode alterar os pagamentos." });
      }
      const [, roundId, memberId] = adminPaymentMatch;
      const body = await readJson(request);
      if (body.status !== "confirmed" && body.status !== "pending") {
        return sendJson(response, 400, { error: "O status deve ser pago ou pendente." });
      }
      const round = state.rounds.find((item) => item.id === roundId);
      if (!round || round.id !== (getCurrentRound(state) || {}).id || !["open", "ready"].includes(round.status)) {
        return sendJson(response, 409, { error: "So e possivel ajustar pagamentos da rodada atual antes do sorteio." });
      }
      const payment = round.payments.find((item) => item.userId === memberId);
      if (!payment) return sendJson(response, 404, { error: "Pagamento nao encontrado nesta rodada." });
      const changedAt = new Date().toISOString();
      payment.status = body.status;
      payment.adminConfirmed = body.status === "confirmed";
      payment.confirmedAt = body.status === "confirmed" ? changedAt : null;
      round.status = round.payments.every((item) => item.status === "confirmed" && item.adminConfirmed) ? "ready" : "open";
      state.audit.push({
        type: body.status === "confirmed" ? "payment_confirmed_by_admin" : "payment_reverted_by_admin",
        at: changedAt,
        roundId,
        userId: memberId,
        actorUserId: current.user.id,
        details: body.status === "confirmed"
          ? "Pagamento confirmado manualmente pelo administrador mestre."
          : "Pagamento marcado como pendente pelo administrador mestre."
      });
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    if (request.method === "GET" && pathname === "/api/state") {
      return sendJson(response, 200, getPublicState(state));
    }

    if (request.method === "GET" && pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write(`data: ${JSON.stringify(getPublicState(state))}\n\n`);
      clients.set(response, {
        userId: current.user.id,
        role: current.user.role,
        tokenHash: current.session.tokenHash
      });
      request.on("close", () => clients.delete(response));
      return;
    }

    const paymentMatch = pathname.match(/^\/api\/rounds\/([^/]+)\/payments\/(member-[1-6])\/confirm$/);
    if (request.method === "POST" && paymentMatch) {
      const [, roundId, memberId] = paymentMatch;
      if (current.user.participantId !== memberId) {
        return sendJson(response, 403, { error: "Voce so pode confirmar o seu proprio pagamento." });
      }
      const round = state.rounds.find((item) => item.id === roundId);
      if (!round) return sendJson(response, 404, { error: "Rodada nao encontrada." });
      const payment = round.payments.find((item) => item.userId === memberId);
      if (!payment) return sendJson(response, 404, { error: "Pagamento nao encontrado nesta rodada." });
      if (round.status !== "open" && round.status !== "ready") {
        return sendJson(response, 409, { error: "Esta rodada nao esta recebendo confirmacoes de pagamento." });
      }
      if (payment.status !== "confirmed") {
        payment.status = "confirmed";
        payment.confirmedAt = new Date().toISOString();
        state.audit.push({
          type: "payment_confirmed_demo",
          at: payment.confirmedAt,
          roundId,
          userId: memberId,
          details: "Pagamento marcado como confirmado no modo demonstrativo."
        });
      }
      round.status = round.payments.every((item) => item.status === "confirmed" && item.adminConfirmed) ? "ready" : "open";
      await persistAndBroadcast();
      return sendJson(response, 200, getPublicState(state));
    }

    const drawMatch = pathname.match(/^\/api\/rounds\/([^/]+)\/draw$/);
    if (request.method === "POST" && drawMatch) {
      const [, roundId] = drawMatch;
      const round = state.rounds.find((item) => item.id === roundId);
      if (current.user.role !== "participant") {
        return sendJson(response, 403, { error: "Cada giro deve ser realizado pela conta do participante correspondente." });
      }
      if (!round || round.id !== (getCurrentRound(state) || {}).id || !["open", "ready"].includes(round.status)) {
        return sendJson(response, 409, { error: "Somente a rodada atual pode receber giros." });
      }
      const registeredParticipantIds = new Set(state.authUsers
        .filter((user) => user.role === "participant")
        .map((user) => user.participantId));
      if (registeredParticipantIds.size !== state.participants.length) {
        return sendJson(response, 409, { error: "Todos os seis participantes precisam estar cadastrados antes dos giros." });
      }
      const participantId = current.user.participantId;
      const participantPayment = round.payments.find((payment) => payment.userId === participantId);
      if (!participantPayment || participantPayment.status !== "confirmed" || !participantPayment.adminConfirmed) {
        return sendJson(response, 403, { error: "Seu pagamento deste mes ainda nao foi aprovado pelo administrador. O acesso a roleta sera liberado apos a confirmacao." });
      }
      if (round.spins.some((spin) => spin.participantId === participantId)) {
        return sendJson(response, 409, { error: "Voce ja realizou seu giro nesta rodada." });
      }
      const previousWinners = new Set(state.rounds
        .filter((item) => item.cycleId === state.cycle.id && item.status === "completed")
        .map((item) => item.winnerId));
      const eligible = state.participants.filter((member) =>
        registeredParticipantIds.has(member.id) && !previousWinners.has(member.id));
      if (eligible.length === 0) {
        return sendJson(response, 409, { error: "Nao ha participantes elegiveis para esta rodada." });
      }

      const spunAt = new Date().toISOString();
      if (round.spins.length === 0) {
        round.drawStartedAt = spunAt;
      }
      const resultId = eligible[randomInt(eligible.length)].id;
      round.spins.push({ participantId, resultId, at: spunAt });
      state.audit.push({
        type: "participant_spin_recorded",
        at: spunAt,
        roundId,
        requestedBy: current.user.id,
        participantId,
        resultId,
        details: "Giro individual registrado pelo servidor com selecao aleatoria segura."
      });
      if (round.spins.length === state.participants.length) {
        round.prizeCents = round.payments
          .filter((payment) => payment.status === "confirmed" && payment.adminConfirmed)
          .reduce((total, payment) => total + payment.amountCents, 0);
        const counts = new Map();
        for (const spin of round.spins) counts.set(spin.resultId, (counts.get(spin.resultId) || 0) + 1);
        const highestCount = Math.max(...counts.values());
        round.tiedParticipantIds = [...counts.entries()]
          .filter(([, count]) => count === highestCount)
          .map(([id]) => id);
        if (round.tiedParticipantIds.length === 1) {
          round.winnerId = round.tiedParticipantIds[0];
          round.tiedParticipantIds = [];
          round.status = "drawing";
          state.audit.push({
            type: "draw_started",
            at: spunAt,
            roundId,
            winnerId: round.winnerId,
            prizeCents: round.prizeCents,
            details: "Ganhador definido automaticamente pela maior quantidade de ocorrencias nos seis giros."
          });
        } else {
          round.winnerId = null;
          round.tieCount += 1;
          state.audit.push({
            type: "draw_tie_restarted",
            at: spunAt,
            roundId,
            attempt: round.tieCount,
            tiedParticipantIds: [...round.tiedParticipantIds],
            highestCount,
            spins: round.spins.map((spin) => ({ ...spin })),
            details: "Os giros terminaram empatados; os resultados foram reiniciados e todos podem girar novamente."
          });
          round.status = round.payments.every((payment) => payment.status === "confirmed" && payment.adminConfirmed)
            ? "ready"
            : "open";
          round.drawStartedAt = null;
          round.drawCompletedAt = null;
          round.spins = [];
          round.tiedParticipantIds = [];
        }
      }
      await persistAndBroadcast();
      if (round.status === "drawing") {
        scheduleDrawCompletion(roundId, drawDurationMs);
      }
      return sendJson(response, 202, getPublicState(state));
    }

    return sendJson(response, 404, { error: "Rota da API nao encontrada." });
  }

  const publicDirectory = path.join(__dirname, "public");
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  };

  const server = http.createServer(async (request, response) => {
    try {
      await ready;
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, response, url.pathname);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Metodo nao permitido." });
      }
      const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const filePathToServe = path.resolve(publicDirectory, `.${requestedPath}`);
      if (!filePathToServe.startsWith(`${publicDirectory}${path.sep}`)) {
        return sendJson(response, 404, { error: "Arquivo nao encontrado." });
      }
      let contents;
      try {
        contents = fs.readFileSync(filePathToServe);
      } catch {
        return sendJson(response, 404, { error: "Arquivo nao encontrado." });
      }
      if (requestedPath === "/index.html") {
        contents = Buffer.from(contents.toString("utf8").replace("__APP_VERSION__", APP_VERSION));
      }
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePathToServe)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      if (!response.headersSent) {
        const statusCode = error.message.includes("JSON") || error.message.includes("tamanho") ? 400 : 500;
        sendJson(response, statusCode, { error: statusCode === 500 ? "Erro interno ao processar a solicitacao." : error.message });
      } else {
        response.destroy(error);
      }
      if (process.env.NODE_ENV !== "test") console.error(error);
    }
  });

  server.on("close", () => {
    closed = true;
    for (const timer of drawTimers.values()) clearTimeout(timer);
    drawTimers.clear();
    for (const client of clients.keys()) client.end();
    clients.clear();
  });

  return { server, ready, close: () => { if (!closed) server.close(); } };
}

if (require.main === module) {
  async function main() {
    if (process.argv.includes("--reset") && fs.existsSync(DEFAULT_DATA_FILE)) {
      fs.unlinkSync(DEFAULT_DATA_FILE);
    }
    if (process.argv.includes("--set-admin-password")) {
      const password = await promptHidden("Nova senha do Administrador Mestre: ");
      const confirmation = await promptHidden("Confirme a nova senha: ");
      if (password !== confirmation) throw new Error("As senhas nao conferem. Nenhuma alteracao foi salva.");
      await setMasterAdminPassword(password);
      console.log("Senha do Administrador Mestre atualizada no armazenamento configurado.");
      return;
    }

    const app = createApp();
    await app.ready;
    app.server.listen(PORT, () => {
      console.log(`Make Money disponivel em http://localhost:${PORT}`);
      console.log(`${process.env.SUPABASE_SERVICE_ROLE_KEY ? "Persistencia Supabase ativa." : "Persistencia local ativa."} Confirmacoes de pagamento continuam sendo demonstrativas.`);
    });
  }

  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, createInitialState, getPublicState, setMasterAdminPassword };
