const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp, createInitialState, setMasterAdminPassword } = require("../server");

test("unlocks spins per approved payment, picks the majority, and restarts tied rounds", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-test-"));
  const resetEmails = [];
  const dataFile = path.join(temporaryDirectory, "state.json");
  let testNow = Date.now();
  let spinCount = 0;
  const app = createApp({
    dataFile,
    drawDurationMs: 20,
    resetCodeSecret: "test-secret-for-password-reset",
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "MasterAdmin123!",
    randomInt: (maximum) => {
      const firstRoundResults = [0, 0, 1, 2, 3, 4];
      const index = spinCount < 6
        ? firstRoundResults[spinCount]
        : spinCount >= 12 && spinCount < 18 ? (spinCount - 12) % 2 : 0;
      spinCount += 1;
      return index % maximum;
    },
    sendResetCodeEmail: async (message) => resetEmails.push(message),
    now: () => testNow
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const cookies = [];

  async function getState(cookie) {
    const response = await fetch(`${baseUrl}/api/state`, {
      headers: cookie ? { Cookie: cookie } : {}
    });
    return response.json();
  }

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  async function confirmRound(roundId) {
    for (let index = 0; index < 6; index += 1) {
      const memberId = `member-${index + 1}`;
      const response = await post(`/api/rounds/${roundId}/payments/${memberId}/confirm`, {}, cookies[index]);
      assert.equal(response.status, 200);
    }
  }

  async function spinRound(roundId, skippedParticipantIds = []) {
    for (let index = 0; index < 6; index += 1) {
      const participantId = `member-${index + 1}`;
      if (skippedParticipantIds.includes(participantId)) continue;
      const response = await post(`/api/rounds/${roundId}/draw`, {}, cookies[index]);
      assert.equal(response.status, 202);
    }
  }

  async function waitForCompleted(roundId) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = await getState(cookies[0]);
      const round = state.rounds.find((item) => item.id === roundId);
      if (round.status === "completed") return round;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${roundId} nao foi concluida dentro do prazo`);
  }

  try {
    const unauthorized = await fetch(`${baseUrl}/api/state`);
    assert.equal(unauthorized.status, 401);

    const adminLogin = await post("/api/auth/signin", {
      email: "ERICKSANTTOS81@gmail.com",
      password: "MasterAdmin123!"
    });
    assert.equal(adminLogin.status, 200);
    const adminUser = await adminLogin.json();
    assert.equal(adminUser.user.role, "admin");
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];

    const participantCannotOpenAdminPanel = await fetch(`${baseUrl}/api/admin/overview`);
    assert.equal(participantCannotOpenAdminPanel.status, 401);

    const invalidEmail = await post("/api/auth/signup", {
      name: "Cadastro Inválido",
      email: "email-invalido",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(invalidEmail.status, 400);

    const mismatchedPassword = await post("/api/auth/signup", {
      name: "Cadastro Inválido",
      email: "invalido@example.com",
      password: "senha123",
      confirmPassword: "diferente"
    });
    assert.equal(mismatchedPassword.status, 400);

    const invalidPixKey = await post("/api/auth/signup", {
      name: "Cadastro Inválido",
      email: "pix-invalido@example.com",
      password: "senha123",
      confirmPassword: "senha123",
      pixKey: 123
    });
    assert.equal(invalidPixKey.status, 400);

    for (let index = 0; index < 6; index += 1) {
      const response = await post("/api/auth/signup", {
        name: `Participante ${index + 1}`,
        email: `member${index + 1}@example.com`,
        password: "senha123",
        confirmPassword: "senha123",
        ...(index === 0 ? { pixKey: "  +5511999999999  " } : {})
      });
      assert.equal(response.status, 200);
      cookies.push(response.headers.get("set-cookie").split(";")[0]);
      if (index === 0) {
        const firstSignupState = await getState(cookies[0]);
        assert.equal(firstSignupState.participants.find((participant) => participant.id === "member-1").name, "Participante 1");
        assert.equal(firstSignupState.participants.find((participant) => participant.id === "member-1").registered, true);
        assert.equal(firstSignupState.participants.filter((participant) => participant.registered).length, 1);
      }
    }

    const adminOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    assert.equal(adminOverview.status, 200);
    const overview = await adminOverview.json();
    assert.equal(overview.confirmedCount, 0);
    assert.equal(overview.participantAccounts.length, 6);
    assert.equal(overview.participantAccounts.some((account) => "passwordHash" in account), false);
    assert.equal(overview.participantAccounts[0].pixKey, "+5511999999999");
    assert.equal(overview.participantAccounts[1].pixKey, "");
    const persistedAccounts = JSON.parse(fs.readFileSync(dataFile, "utf8")).authUsers;
    assert.equal(persistedAccounts.find((user) => user.participantId === "member-1").pixKey, "+5511999999999");
    const regularState = await getState(cookies[0]);
    assert.equal("participantAccounts" in regularState, false);
    assert.ok(regularState.participants.every((participant) => participant.registered));
    assert.ok(regularState.participants.every((participant) => !("pixKey" in participant)));
    assert.equal(regularState.participants.find((participant) => participant.id === "member-1").name, "Participante 1");
    assert.deepEqual(regularState.wheelOrder, [
      "member-1", "member-2", "member-3", "member-4", "member-5", "member-6"
    ]);

    const participantCannotOpenAdminPanelAfterLogin = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Cookie: cookies[0] }
    });
    assert.equal(participantCannotOpenAdminPanelAfterLogin.status, 403);

    const participantCannotManagePayments = await post(
      "/api/admin/rounds/round-1/payments/member-1",
      { status: "confirmed" },
      cookies[0]
    );
    assert.equal(participantCannotManagePayments.status, 403);

    const roster = regularState.participants.map((participant, index) => ({
      id: participant.id,
      name: participant.id === "member-1" ? "Leidiane Pereira" : participant.name,
      position: participant.id === "member-1" ? 6 : index
    }));
    const participantCannotEditRouletteRoster = await post(
      "/api/admin/roulette/participants",
      { participants: roster },
      cookies[0]
    );
    assert.equal(participantCannotEditRouletteRoster.status, 403);

    const duplicatePositions = await post("/api/admin/roulette/participants", {
      participants: roster.map((participant) => ({ ...participant, position: 1 }))
    }, adminCookie);
    assert.equal(duplicatePositions.status, 400);

    const rosterUpdated = await post("/api/admin/roulette/participants", { participants: roster }, adminCookie);
    assert.equal(rosterUpdated.status, 200);
    const updatedRosterState = await rosterUpdated.json();
    assert.equal(updatedRosterState.participants.find((participant) => participant.id === "member-1").name, "Leidiane Pereira");
    assert.deepEqual(updatedRosterState.wheelOrder, [
      "member-2", "member-3", "member-4", "member-5", "member-6", "member-1"
    ]);
    assert.equal(updatedRosterState.audit[0].type, "roulette_participant_updated_by_admin");
    const updatedParticipantSession = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookies[0] } });
    assert.equal((await updatedParticipantSession.json()).user.name, "Leidiane Pereira");

    const duplicateEmail = await post("/api/auth/signup", {
      name: "Outro Nome",
      email: "MEMBER1@example.com",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(duplicateEmail.status, 409);

    const occupiedSlot = await post("/api/auth/signup", {
      name: "Sétimo Participante",
      email: "member7@example.com",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(occupiedSlot.status, 409);

    const wrongPassword = await post("/api/auth/signin", {
      email: "member1@example.com",
      password: "incorreta"
    });
    assert.equal(wrongPassword.status, 401);

    const wrongPayer = await post("/api/rounds/round-1/payments/member-2/confirm", {}, cookies[0]);
    assert.equal(wrongPayer.status, 403);

    const blockedDraw = await post("/api/rounds/round-1/draw", {}, cookies[0]);
    assert.equal(blockedDraw.status, 403);
    assert.match((await blockedDraw.json()).error, /Seu pagamento.*nao foi aprovado pelo administrador/);

    await confirmRound("round-1");
    assert.equal((await getState(adminCookie)).currentRound.status, "open");
    const selfReportedOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    assert.equal((await selfReportedOverview.json()).confirmedCount, 0);
    const selfReportedButNotAdminApproved = await post("/api/rounds/round-1/draw", {}, cookies[0]);
    assert.equal(selfReportedButNotAdminApproved.status, 403);
    assert.match((await selfReportedButNotAdminApproved.json()).error, /Seu pagamento.*nao foi aprovado pelo administrador/);

    const approveSecondParticipant = await post(
      "/api/admin/rounds/round-1/payments/member-2",
      { status: "confirmed" },
      adminCookie
    );
    assert.equal(approveSecondParticipant.status, 200);
    const approvedOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    assert.equal((await approvedOverview.json()).confirmedCount, 1);
    assert.equal((await getState(adminCookie)).currentRound.status, "open");
    const paidParticipantDrawsWithOtherPaymentsPending = await post("/api/rounds/round-1/draw", {}, cookies[1]);
    assert.equal(paidParticipantDrawsWithOtherPaymentsPending.status, 202);
    const partialPaymentState = await getState(adminCookie);
    assert.equal(partialPaymentState.currentRound.spins.length, 1);
    assert.equal(partialPaymentState.currentRound.payments.filter((payment) => payment.adminConfirmed).length, 1);
    const duplicatePersonalSpin = await post("/api/rounds/round-1/draw", {}, cookies[1]);
    assert.equal(duplicatePersonalSpin.status, 409);

    for (let index = 0; index < 6; index += 1) {
      if (index === 1) continue;
      const markedPaid = await post(
        `/api/admin/rounds/round-1/payments/member-${index + 1}`,
        { status: "confirmed" },
        adminCookie
      );
      assert.equal(markedPaid.status, 200);
    }
    assert.equal((await getState(adminCookie)).currentRound.status, "ready");

    const revertedToPending = await post(
      "/api/admin/rounds/round-1/payments/member-1",
      { status: "pending" },
      adminCookie
    );
    assert.equal(revertedToPending.status, 200);
    assert.equal((await getState(adminCookie)).currentRound.status, "open");
    const drawWhileAdminMarkedPending = await post("/api/rounds/round-1/draw", {}, cookies[0]);
    assert.equal(drawWhileAdminMarkedPending.status, 403);
    assert.match((await drawWhileAdminMarkedPending.json()).error, /Seu pagamento.*nao foi aprovado pelo administrador/);
    const approveLastPayment = await post(
      "/api/admin/rounds/round-1/payments/member-1",
      { status: "confirmed" },
      adminCookie
    );
    assert.equal(approveLastPayment.status, 200);
    await spinRound("round-1", ["member-2"]);
    assert.equal(await waitForCompleted("round-1").then((round) => round.prizeCents), 6000);

    const firstWinner = await waitForCompleted("round-1");
    let state = await getState(cookies[0]);
    const firstCompletedRound = state.rounds.find((round) => round.id === "round-1");
    assert.equal(firstCompletedRound.spins.length, 6);
    assert.equal(firstWinner.winnerId, "member-1");
    assert.equal(firstCompletedRound.spins.filter((spin) => spin.resultId === firstWinner.winnerId).length, 2);
    assert.equal(state.audit.filter((entry) => entry.type === "participant_spin_recorded").length, 6);
    assert.equal(state.audit.filter((entry) => entry.type === "draw_started").length, 1);
    assert.equal(state.currentRound.id, "round-2");
    const eventResponse = await fetch(`${baseUrl}/api/events`, { headers: { Cookie: cookies[0] } });
    const eventReader = eventResponse.body.getReader();
    await eventReader.read();

    const replacementWinnerId = state.participants.find((participant) => participant.id !== firstWinner.winnerId).id;
    const participantCannotEditWinner = await post(
      "/api/admin/rounds/round-1/winner",
      { winnerId: replacementWinnerId },
      cookies[0]
    );
    assert.equal(participantCannotEditWinner.status, 403);

    const updatedWinner = await post(
      "/api/admin/rounds/round-1/winner",
      { winnerId: replacementWinnerId },
      adminCookie
    );
    assert.equal(updatedWinner.status, 200);
    state = await updatedWinner.json();
    assert.equal(state.latestResult.winnerId, replacementWinnerId);
    assert.equal(state.rounds.find((round) => round.id === "round-1").winnerId, replacementWinnerId);
    assert.equal(state.audit[0].type, "draw_winner_corrected_by_admin");
    const eventUpdate = await eventReader.read();
    const eventText = new TextDecoder().decode(eventUpdate.value);
    const eventPayload = JSON.parse(eventText.slice(eventText.indexOf("data: ") + 6).trim());
    assert.equal(eventPayload.latestResult.winnerId, replacementWinnerId);
    await eventReader.cancel();

    await confirmRound("round-2");
    for (let index = 0; index < 6; index += 1) {
      const verified = await post(
        `/api/admin/rounds/round-2/payments/member-${index + 1}`,
        { status: "confirmed" },
        adminCookie
      );
      assert.equal(verified.status, 200);
    }
    await spinRound("round-2");
    const secondWinner = await waitForCompleted("round-2");
    assert.notEqual(replacementWinnerId, secondWinner.winnerId);
    const duplicateCycleWinner = await post(
      "/api/admin/rounds/round-2/winner",
      { winnerId: replacementWinnerId },
      adminCookie
    );
    assert.equal(duplicateCycleWinner.status, 409);

    const cannotEditOlderRound = await post(
      "/api/admin/rounds/round-1/winner",
      { winnerId: firstWinner.winnerId },
      adminCookie
    );
    assert.equal(cannotEditOlderRound.status, 409);

    await confirmRound("round-3");
    for (let index = 0; index < 6; index += 1) {
      const verified = await post(
        `/api/admin/rounds/round-3/payments/member-${index + 1}`,
        { status: "confirmed" },
        adminCookie
      );
      assert.equal(verified.status, 200);
    }
    const prematureManualWinner = await post(
      "/api/admin/rounds/round-3/winner",
      { winnerId: "member-3" },
      adminCookie
    );
    assert.equal(prematureManualWinner.status, 409);
    await spinRound("round-3");
    state = await getState(adminCookie);
    assert.equal(state.currentRound.status, "ready");
    assert.equal(state.currentRound.tieCount, 1);
    assert.deepEqual(state.currentRound.spins, []);
    assert.deepEqual(state.currentRound.tiedParticipantIds, []);
    const tieAudit = state.audit.find((entry) => entry.type === "draw_tie_restarted" && entry.roundId === "round-3");
    assert.deepEqual(tieAudit.tiedParticipantIds, ["member-3", "member-4"]);
    assert.equal(tieAudit.spins.length, 6);

    const rosterLockedAfterTie = await post("/api/admin/roulette/participants", { participants: roster }, adminCookie);
    assert.equal(rosterLockedAfterTie.status, 409);
    await spinRound("round-3");
    const restartedRoundWinner = await waitForCompleted("round-3");
    assert.equal(restartedRoundWinner.winnerId, "member-3");
    assert.equal(restartedRoundWinner.spins.length, 6);
    state = await getState(adminCookie);
    assert.equal(state.latestResult.winnerId, "member-3");
    assert.equal(state.currentRound.id, "round-4");
    assert.equal(state.audit.find((entry) => entry.type === "draw_tie_restarted").attempt, 1);
    const persistedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.equal(persistedState.rounds.find((round) => round.id === "round-3").winnerId, "member-3");

    const logout = await post("/api/auth/logout", {}, cookies[0]);
    assert.equal(logout.status, 200);
    const loggedOutState = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookies[0] } });
    assert.equal(loggedOutState.status, 401);

    const login = await post("/api/auth/signin", {
      email: "member1@example.com",
      password: "senha123"
    });
    assert.equal(login.status, 200);
    const restoredCookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(login.headers.get("set-cookie").includes("HttpOnly"), true);
    assert.equal(login.headers.get("set-cookie").includes("SameSite=Strict"), true);
    assert.equal((await getState(restoredCookie)).participants.length, 6);

    const unknownReset = await post("/api/auth/password-reset/request", { email: "unknown@example.com" });
    assert.equal(unknownReset.status, 200);
    assert.equal(resetEmails.length, 0);

    const resetRequest = await post("/api/auth/password-reset/request", { email: "MEMBER1@example.com" });
    assert.equal(resetRequest.status, 200);
    assert.match((await resetRequest.json()).message, /Se o e-mail estiver cadastrado/);
    assert.equal(resetEmails.length, 1);
    assert.equal(resetEmails[0].email, "member1@example.com");
    assert.match(resetEmails[0].code, /^\d{6}$/);

    const tooSoon = await post("/api/auth/password-reset/request", { email: "member1@example.com" });
    assert.equal(tooSoon.status, 429);

    const wrongResetCode = await post("/api/auth/password-reset/confirm", {
      email: "member1@example.com",
      code: "000000" === resetEmails[0].code ? "000001" : "000000",
      newPassword: "novaSenha123",
      confirmPassword: "novaSenha123"
    });
    assert.equal(wrongResetCode.status, 400);

    const confirmedReset = await post("/api/auth/password-reset/confirm", {
      email: "member1@example.com",
      code: resetEmails[0].code,
      newPassword: "novaSenha123",
      confirmPassword: "novaSenha123"
    });
    assert.equal(confirmedReset.status, 200);
    assert.match((await confirmedReset.json()).message, /Senha alterada/);

    const invalidatedSession = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: restoredCookie } });
    assert.equal(invalidatedSession.status, 401);

    const oldPasswordLogin = await post("/api/auth/signin", {
      email: "member1@example.com",
      password: "senha123"
    });
    assert.equal(oldPasswordLogin.status, 401);

    const newPasswordLogin = await post("/api/auth/signin", {
      email: "member1@example.com",
      password: "novaSenha123"
    });
    assert.equal(newPasswordLogin.status, 200);

    const reusedCode = await post("/api/auth/password-reset/confirm", {
      email: "member1@example.com",
      code: resetEmails[0].code,
      newPassword: "senhaOutro123",
      confirmPassword: "senhaOutro123"
    });
    assert.equal(reusedCode.status, 400);

    const expiringRequest = await post("/api/auth/password-reset/request", { email: "member2@example.com" });
    assert.equal(expiringRequest.status, 200);
    testNow += 16 * 60 * 1000;
    const expiredCode = await post("/api/auth/password-reset/confirm", {
      email: "member2@example.com",
      code: resetEmails[1].code,
      newPassword: "novaSenha456",
      confirmPassword: "novaSenha456"
    });
    assert.equal(expiredCode.status, 400);
    assert.match((await expiredCode.json()).error, /invalido ou expirado/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("restarts legacy tied rounds when loading saved state", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-tie-recovery-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const state = createInitialState();
  const round = state.rounds[0];
  round.status = "tied";
  round.tiedParticipantIds = ["member-1", "member-2"];
  round.spins = Array.from({ length: 6 }, (_, index) => ({
    participantId: `member-${index + 1}`,
    resultId: index < 3 ? "member-1" : "member-2",
    at: new Date().toISOString()
  }));
  round.payments.forEach((payment) => {
    payment.status = "confirmed";
    payment.adminConfirmed = true;
  });
  delete round.tieCount;
  fs.writeFileSync(dataFile, JSON.stringify(state), "utf8");

  const app = createApp({
    dataFile,
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));

  try {
    const recoveredState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const recoveredRound = recoveredState.rounds[0];
    assert.equal(recoveredRound.status, "ready");
    assert.equal(recoveredRound.tieCount, 1);
    assert.deepEqual(recoveredRound.spins, []);
    assert.deepEqual(recoveredRound.tiedParticipantIds, []);
    const tieAudit = recoveredState.audit.find((entry) => entry.type === "draw_tie_restarted");
    assert.deepEqual(tieAudit.tiedParticipantIds, ["member-1", "member-2"]);
    assert.equal(tieAudit.spins.length, 6);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("records a legacy completed cycle and waits for the administrator to start another", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-completed-cycle-recovery-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const state = createInitialState();
  for (const [index, round] of state.rounds.entries()) {
    round.status = "completed";
    round.winnerId = `member-${index + 1}`;
    round.drawCompletedAt = new Date().toISOString();
    round.payments.forEach((payment) => {
      payment.status = "confirmed";
      payment.adminConfirmed = true;
      payment.confirmedAt = round.drawCompletedAt;
    });
  }
  fs.writeFileSync(dataFile, JSON.stringify(state), "utf8");

  const app = createApp({
    dataFile,
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));

  try {
    const migratedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const originalRounds = migratedState.rounds.filter((round) => round.cycleId === "demo-cycle");

    assert.equal(originalRounds.length, 6);
    assert.ok(originalRounds.every((round, index) =>
      round.status === "completed" && round.winnerId === `member-${index + 1}`));
    assert.equal(migratedState.cycleHistory.length, 1);
    assert.equal(migratedState.cycleHistory[0].id, "demo-cycle");
    assert.equal(migratedState.cycle.status, "completed");
    assert.equal(migratedState.cycle.number, 1);
    assert.equal(migratedState.rounds.length, 6);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("records one approved participant spin at a time and completes after all six participants spin", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-individual-draw-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({
    dataFile,
    drawDurationMs: 20,
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "MasterAdmin123!",
    randomInt: () => 0
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "ericksanttos81@gmail.com",
      password: "MasterAdmin123!"
    });
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
    const participantCookies = [];
    for (let index = 0; index < 6; index += 1) {
      const signup = await post("/api/auth/signup", {
        name: `Membro ${index + 1}`,
        email: `individual${index + 1}@example.com`,
        password: "senha123",
        confirmPassword: "senha123"
      });
      assert.equal(signup.status, 200);
      participantCookies.push(signup.headers.get("set-cookie").split(";")[0]);
    }

    const adminDrawWithoutAnyApprovedPayment = await post("/api/rounds/round-1/draw", {}, adminCookie);
    assert.equal(adminDrawWithoutAnyApprovedPayment.status, 403);

    const participantPayment = await post(
      "/api/rounds/round-1/payments/member-1/confirm",
      {},
      participantCookies[0]
    );
    assert.equal(participantPayment.status, 200);

    const nonPayerCannotDraw = await post("/api/rounds/round-1/draw", {}, participantCookies[1]);
    assert.equal(nonPayerCannotDraw.status, 403);
    assert.match((await nonPayerCannotDraw.json()).error, /Seu pagamento.*nao foi aprovado pelo administrador/);

    const approval = await post("/api/admin/rounds/round-1/payments/member-1", { status: "confirmed" }, adminCookie);
    assert.equal(approval.status, 200);
    const approvedState = await approval.json();
    assert.equal(approvedState.currentRound.status, "open");
    assert.equal(approvedState.currentRound.payments.filter((payment) => payment.adminConfirmed).length, 1);

    const draw = await post("/api/rounds/round-1/draw", {}, participantCookies[0]);
    assert.equal(draw.status, 202);
    const drawingState = await draw.json();
    assert.equal(drawingState.currentRound.status, "open");
    assert.equal(drawingState.currentRound.spins.length, 1);
    assert.equal(drawingState.currentRound.spins[0].participantId, "member-1");
    const duplicateSpin = await post("/api/rounds/round-1/draw", {}, participantCookies[0]);
    assert.equal(duplicateSpin.status, 409);

    for (let index = 1; index < 6; index += 1) {
      const approval = await post(
        `/api/admin/rounds/round-1/payments/member-${index + 1}`,
        { status: "confirmed" },
        adminCookie
      );
      assert.equal(approval.status, 200);
      const participantSpin = await post("/api/rounds/round-1/draw", {}, participantCookies[index]);
      assert.equal(participantSpin.status, 202);
    }

    const deadline = Date.now() + 2000;
    let completedState;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: adminCookie } });
      completedState = await response.json();
      if (completedState.latestResult?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completedState.latestResult.status, "completed");
    assert.equal(completedState.latestResult.prizeCents, 6000);
    assert.equal(completedState.latestResult.spins.length, 6);
    assert.equal(completedState.currentRound.id, "round-2");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("renews the cycle after round six while preserving history and resetting payments", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-cycle-renewal-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({
    dataFile,
    drawDurationMs: 10,
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "MasterAdmin123!",
    randomInt: () => 0
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  async function getState(cookie) {
    const response = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } });
    return response.json();
  }

  async function waitForCompleted(roundId, cookie) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const state = await getState(cookie);
      const round = state.rounds.find((item) => item.id === roundId);
      if (round?.status === "completed") return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${roundId} nao foi concluida dentro do prazo`);
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "ericksanttos81@gmail.com",
      password: "MasterAdmin123!"
    });
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
    const participantCookies = [];
    for (let index = 0; index < 6; index += 1) {
      const signup = await post("/api/auth/signup", {
        name: `Membro ${index + 1}`,
        email: `renewal${index + 1}@example.com`,
        password: "senha123",
        confirmPassword: "senha123"
      });
      assert.equal(signup.status, 200);
      participantCookies.push(signup.headers.get("set-cookie").split(";")[0]);
    }

    let state = await getState(adminCookie);
    for (let number = 1; number <= 6; number += 1) {
      const round = state.currentRound;
      assert.equal(round.number, number);
      for (let index = 0; index < 6; index += 1) {
        const approval = await post(
          `/api/admin/rounds/${round.id}/payments/member-${index + 1}`,
          { status: "confirmed" },
          adminCookie
        );
        assert.equal(approval.status, 200);
      }
      for (const cookie of participantCookies) {
        const spin = await post(`/api/rounds/${round.id}/draw`, {}, cookie);
        assert.equal(spin.status, 202);
      }
      state = await waitForCompleted(round.id, adminCookie);
    }

    assert.equal(state.cycle.status, "completed");
    assert.equal(state.cycle.number, 1);
    assert.equal(state.cycleHistory.length, 1);
    assert.equal(state.cycleHistory[0].status, "completed");
    assert.equal(state.rounds.filter((round) => round.cycleId === "demo-cycle").length, 6);
    assert.equal(state.rounds.filter((round) => round.status === "completed").length, 6);
    assert.equal(state.currentRound, null);

    const participantCannotStartCycle = await post("/api/admin/cycles/renew", {}, participantCookies[0]);
    assert.equal(participantCannotStartCycle.status, 403);

    const startCycle = await post("/api/admin/cycles/renew", {}, adminCookie);
    assert.equal(startCycle.status, 200);
    state = await startCycle.json();
    assert.equal(state.cycle.status, "active");
    assert.equal(state.cycle.number, 2);
    assert.equal(state.cycleHistory.length, 1);
    assert.equal(state.rounds.filter((round) => round.cycleId === "demo-cycle").length, 6);
    assert.equal(state.rounds.filter((round) => round.cycleId === state.cycle.id).length, 6);
    assert.equal(state.rounds.filter((round) => round.status === "completed").length, 6);
    assert.equal(state.currentRound.number, 1);
    assert.equal(state.currentRound.status, "open");
    assert.equal(state.currentRound.spins.length, 0);
    assert.ok(state.currentRound.payments.every((payment) =>
      payment.status === "pending" && payment.adminConfirmed === false && payment.confirmedAt === null));

    for (let index = 0; index < 6; index += 1) {
      const approval = await post(
        `/api/admin/rounds/${state.currentRound.id}/payments/member-${index + 1}`,
        { status: "confirmed" },
        adminCookie
      );
      assert.equal(approval.status, 200);
    }
    const firstNewCycleSpin = await post(`/api/rounds/${state.currentRound.id}/draw`, {}, participantCookies[0]);
    assert.equal(firstNewCycleSpin.status, 202);
    const renewedState = await firstNewCycleSpin.json();
    assert.equal(renewedState.currentRound.spins.length, 1);
    assert.equal(renewedState.currentRound.spins[0].participantId, "member-1");
    assert.equal(renewedState.currentRound.payments[0].status, "confirmed");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("updates an existing master admin with server-configured credentials", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-admin-config-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const firstOptions = {
    dataFile,
    adminEmail: "ericksanttos81@gmail.com",
    adminPassword: "FirstMasterPassword123!"
  };
  const firstApp = createApp(firstOptions);
  await new Promise((resolve) => firstApp.server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => firstApp.server.close(resolve));

  const updatedApp = createApp({
    ...firstOptions,
    adminPassword: "SecondMasterPassword456!"
  });
  await new Promise((resolve) => updatedApp.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${updatedApp.server.address().port}`;

  try {
    const oldPassword = await fetch(`${baseUrl}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ericksanttos81@gmail.com",
        password: "FirstMasterPassword123!"
      })
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await fetch(`${baseUrl}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ericksanttos81@gmail.com",
        password: "SecondMasterPassword456!"
      })
    });
    assert.equal(newPassword.status, 200);
  } finally {
    await new Promise((resolve) => updatedApp.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("sets a simple master admin password and stores only its hash", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-simple-admin-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  try {
    setMasterAdminPassword("short", {
      dataFile,
      adminEmail: "ericksanttos81@gmail.com",
    });
    const savedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const admin = savedState.authUsers.find((user) => user.role === "admin");
    assert.ok(admin);
    assert.equal(admin.passwordHash.includes("short"), false);
    assert.equal(admin.passwordSalt.includes("short"), false);

    const app = createApp({ dataFile, adminEmail: "ericksanttos81@gmail.com" });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ericksanttos81@gmail.com", password: "short" })
      });
      assert.equal(response.status, 200);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("configures the master admin once through the local browser setup endpoint", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-admin-setup-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({ dataFile });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  try {
    const initialSession = await fetch(`${baseUrl}/api/auth/session`);
    assert.deepEqual(await initialSession.json(), { user: null, setupRequired: true });

    const remoteHostSetup = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: app.server.address().port,
        path: "/api/auth/setup/admin",
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "example.com" }
      }, (response) => {
        response.resume();
        resolve(response);
      });
      request.on("error", reject);
      request.end(JSON.stringify({ password: "LocalAdminPass123", confirmPassword: "LocalAdminPass123" }));
    });
    assert.equal(remoteHostSetup.statusCode, 403);

    const response = await fetch(`${baseUrl}/api/auth/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "LocalAdminPass123", confirmPassword: "LocalAdminPass123" })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.user.role, "admin");
    assert.ok(response.headers.get("set-cookie"));

    const storedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    const admin = storedState.authUsers.find((user) => user.role === "admin");
    assert.ok(admin);
    assert.equal(admin.email, "ericksanttos81@gmail.com");
    assert.equal(admin.passwordHash.includes("LocalAdminPass123"), false);
    assert.equal(admin.passwordSalt.includes("LocalAdminPass123"), false);

    const adminLogin = await fetch(`${baseUrl}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ericksanttos81@gmail.com", password: "LocalAdminPass123" })
    });
    assert.equal(adminLogin.status, 200);
    assert.equal((await adminLogin.json()).user.role, "admin");

    const repeatedSetup = await fetch(`${baseUrl}/api/auth/setup/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "AnotherAdminPass123", confirmPassword: "AnotherAdminPass123" })
    });
    assert.equal(repeatedSetup.status, 409);

    const completedSession = await fetch(`${baseUrl}/api/auth/session`);
    assert.deepEqual(await completedSession.json(), { user: null, setupRequired: false });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("master admin deletes participant credentials and profile while preserving the game slot", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-account-deletion-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({
    dataFile,
    adminEmail: "admin@example.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "admin@example.com",
      password: "MasterAdmin123!"
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];

    const signup = await post("/api/auth/signup", {
      name: "Perfil que sera removido",
      email: "reutilizavel@example.com",
      password: "SenhaAntiga123",
      confirmPassword: "SenhaAntiga123"
    });
    assert.equal(signup.status, 200);
    const oldUser = (await signup.json()).user;
    const participantCookie = signup.headers.get("set-cookie").split(";")[0];

    const unauthorizedDelete = await fetch(`${baseUrl}/api/admin/participants/${oldUser.participantId}`, {
      method: "DELETE",
      headers: { Cookie: participantCookie }
    });
    assert.equal(unauthorizedDelete.status, 403);

    for (let index = 2; index <= 6; index += 1) {
      const additionalSignup = await post("/api/auth/signup", {
        name: `Participante ${index}`,
        email: `participante${index}@example.com`,
        password: "SenhaDeTeste123",
        confirmPassword: "SenhaDeTeste123"
      });
      assert.equal(additionalSignup.status, 200);
    }

    const approvedPayment = await post(
      `/api/admin/rounds/round-1/payments/${oldUser.participantId}`,
      { status: "confirmed" },
      adminCookie
    );
    assert.equal(approvedPayment.status, 200);
    const firstSpin = await post("/api/rounds/round-1/draw", {}, participantCookie);
    assert.equal(firstSpin.status, 202);
    const gameStateBeforeDelete = await firstSpin.json();

    const deletion = await fetch(`${baseUrl}/api/admin/participants/${oldUser.participantId}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie }
    });
    assert.equal(deletion.status, 200);
    const deletedState = await deletion.json();
    assert.equal(deletedState.participants.find((item) => item.id === oldUser.participantId).name, "Ana");
    assert.equal(deletedState.participants.find((item) => item.id === oldUser.participantId).registered, false);
    assert.deepEqual(deletedState.cycle, gameStateBeforeDelete.cycle);
    assert.deepEqual(deletedState.rounds, gameStateBeforeDelete.rounds);
    assert.deepEqual(deletedState.wheelOrder, gameStateBeforeDelete.wheelOrder);

    const oldSession = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: participantCookie } });
    assert.equal(oldSession.status, 401);

    const savedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.equal(savedState.authUsers.some((user) => user.id === oldUser.id || user.email === "reutilizavel@example.com"), false);
    assert.equal(savedState.sessions.some((session) => session.userId === oldUser.id), false);
    assert.equal(JSON.stringify(savedState).includes("Perfil que sera removido"), false);
    assert.equal(JSON.stringify(savedState.audit).includes(oldUser.id), false);

    const recadastro = await post("/api/auth/signup", {
      name: "Perfil novo",
      email: "REUTILIZAVEL@example.com",
      password: "SenhaNova123",
      confirmPassword: "SenhaNova123"
    });
    assert.equal(recadastro.status, 200);
    const newUser = (await recadastro.json()).user;
    assert.notEqual(newUser.id, oldUser.id);
    assert.equal(newUser.email, "reutilizavel@example.com");
    assert.equal(newUser.name, "Perfil novo");

    const oldPasswordLogin = await post("/api/auth/signin", {
      email: "reutilizavel@example.com",
      password: "SenhaAntiga123"
    });
    assert.equal(oldPasswordLogin.status, 401);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("master admin configures shared Pix payment details without changing cycle records", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-pix-payment-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({
    dataFile,
    adminEmail: "admin@example.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "admin@example.com",
      password: "MasterAdmin123!"
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];

    const participantSignup = await post("/api/auth/signup", {
      name: "Participante Pix",
      email: "pix@example.com",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(participantSignup.status, 200);
    const participantCookie = participantSignup.headers.get("set-cookie").split(";")[0];

    const initialParticipantStateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: participantCookie }
    });
    const initialParticipantState = await initialParticipantStateResponse.json();
    assert.deepEqual(initialParticipantState.pixPayment, { copyPaste: "", qrCodeUrl: "" });

    const initialRounds = initialParticipantState.rounds;
    const participantCannotConfigurePix = await post("/api/admin/pix-payment", {
      copyPaste: "000201...",
      qrCodeUrl: "https://example.com/qr.png"
    }, participantCookie);
    assert.equal(participantCannotConfigurePix.status, 403);

    const invalidQrUrl = await post("/api/admin/pix-payment", {
      copyPaste: "000201...",
      qrCodeUrl: "javascript:alert(1)"
    }, adminCookie);
    assert.equal(invalidQrUrl.status, 400);

    const configured = await post("/api/admin/pix-payment", {
      copyPaste: "  000201010212EXEMPLO  ",
      qrCodeUrl: " https://example.com/pix-qr.png "
    }, adminCookie);
    assert.equal(configured.status, 200);
    const configuredState = await configured.json();
    assert.deepEqual(configuredState.pixPayment, {
      copyPaste: "000201010212EXEMPLO",
      qrCodeUrl: "https://example.com/pix-qr.png"
    });
    assert.deepEqual(configuredState.rounds, initialRounds);

    const participantStateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: participantCookie }
    });
    const participantState = await participantStateResponse.json();
    assert.deepEqual(participantState.pixPayment, configuredState.pixPayment);
    assert.deepEqual(participantState.rounds, initialRounds);

    const savedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.deepEqual(savedState.pixPayment, configuredState.pixPayment);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("master admin configures each round contribution and cannot change a started round", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-round-values-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const app = createApp({
    dataFile,
    adminEmail: "admin@example.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "admin@example.com",
      password: "MasterAdmin123!"
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];

    const participantSignup = await post("/api/auth/signup", {
      name: "Participante dos valores",
      email: "round-values@example.com",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(participantSignup.status, 200);
    const participantCookie = participantSignup.headers.get("set-cookie").split(";")[0];

    const initialValues = [1000, 1100, 1200, 1300, 1400, 1500];
    const participantCannotConfigureValues = await post("/api/admin/cycles/round-values", {
      roundContributionCents: initialValues
    }, participantCookie);
    assert.equal(participantCannotConfigureValues.status, 403);

    const invalidValues = await post("/api/admin/cycles/round-values", {
      roundContributionCents: [1000, 1100, 0, 1300, 1400, 1500]
    }, adminCookie);
    assert.equal(invalidValues.status, 400);

    const configured = await post("/api/admin/cycles/round-values", {
      roundContributionCents: initialValues
    }, adminCookie);
    assert.equal(configured.status, 200);
    const configuredState = await configured.json();
    assert.deepEqual(configuredState.cycle.roundContributionCents, initialValues);
    for (const [index, round] of configuredState.rounds.filter((item) => item.cycleId === configuredState.cycle.id).entries()) {
      assert.equal(round.payments[0].amountCents, initialValues[index]);
      assert.equal(round.prizeCents, initialValues[index] * 6);
    }

    const participantStateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: participantCookie }
    });
    const participantState = await participantStateResponse.json();
    assert.equal(participantState.currentRound.payments[0].amountCents, 1000);

    const participantPayment = await post("/api/rounds/round-1/payments/member-1/confirm", {}, participantCookie);
    assert.equal(participantPayment.status, 200);

    const changedStartedRound = await post("/api/admin/cycles/round-values", {
      roundContributionCents: [1050, 1100, 1200, 1300, 1400, 1500]
    }, adminCookie);
    assert.equal(changedStartedRound.status, 409);

    const updatedFutureRounds = await post("/api/admin/cycles/round-values", {
      roundContributionCents: [1000, 1150, 1250, 1350, 1450, 1550]
    }, adminCookie);
    assert.equal(updatedFutureRounds.status, 200);
    const updatedState = await updatedFutureRounds.json();
    assert.deepEqual(updatedState.cycle.roundContributionCents, [1000, 1150, 1250, 1350, 1450, 1550]);
    assert.equal(updatedState.rounds.find((round) => round.id === "round-1").payments[0].amountCents, 1000);
    assert.equal(updatedState.rounds.find((round) => round.id === "round-2").payments[0].amountCents, 1150);
    assert.equal(updatedState.rounds.find((round) => round.id === "round-2").prizeCents, 6900);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("master admin removes a completed draw from history without changing cycle records", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-history-delete-test-"));
  const dataFile = path.join(temporaryDirectory, "state.json");
  const initialState = createInitialState();
  const completedRound = initialState.rounds[0];
  completedRound.status = "completed";
  completedRound.winnerId = "member-2";
  completedRound.prizeCents = 4800;
  completedRound.drawCompletedAt = new Date().toISOString();
  completedRound.spins = Array.from({ length: 6 }, (_, index) => ({
    participantId: `member-${index + 1}`,
    resultId: "member-2",
    at: completedRound.drawCompletedAt
  }));
  completedRound.payments.forEach((payment) => {
    payment.status = "confirmed";
    payment.adminConfirmed = true;
    payment.confirmedAt = completedRound.drawCompletedAt;
  });
  initialState.rounds[1].status = "open";
  fs.writeFileSync(dataFile, JSON.stringify(initialState), "utf8");

  const app = createApp({
    dataFile,
    adminEmail: "admin@example.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  async function post(url, body, cookie) {
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  }

  try {
    const adminLogin = await post("/api/auth/signin", {
      email: "admin@example.com",
      password: "MasterAdmin123!"
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];

    const participantSignup = await post("/api/auth/signup", {
      name: "Participante histórico",
      email: "history@example.com",
      password: "senha123",
      confirmPassword: "senha123"
    });
    assert.equal(participantSignup.status, 200);
    const participantCookie = participantSignup.headers.get("set-cookie").split(";")[0];

    const beforeResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: participantCookie }
    });
    const before = await beforeResponse.json();
    assert.equal(before.currentRound.id, "round-2");
    assert.equal(before.history.length, 1);
    assert.equal(before.history[0].id, "round-1");

    const participantCannotDeleteHistory = await fetch(`${baseUrl}/api/admin/history/round-1`, {
      method: "DELETE",
      headers: { Cookie: participantCookie }
    });
    assert.equal(participantCannotDeleteHistory.status, 403);

    const deleted = await fetch(`${baseUrl}/api/admin/history/round-1`, {
      method: "DELETE",
      headers: { Cookie: adminCookie }
    });
    assert.equal(deleted.status, 200);
    const deletedState = await deleted.json();
    assert.deepEqual(deletedState.history, []);
    assert.equal(deletedState.currentRound.id, before.currentRound.id);
    assert.deepEqual(deletedState.cycle, before.cycle);
    assert.deepEqual(deletedState.cycleHistory, before.cycleHistory);
    assert.deepEqual(deletedState.rounds, before.rounds);
    assert.equal(deletedState.participants.length, before.participants.length);

    const duplicateDelete = await fetch(`${baseUrl}/api/admin/history/round-1`, {
      method: "DELETE",
      headers: { Cookie: adminCookie }
    });
    assert.equal(duplicateDelete.status, 404);

    const savedState = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.deepEqual(savedState.deletedHistoryRoundIds, ["round-1"]);
    assert.deepEqual(savedState.rounds, initialState.rounds);
    assert.equal(savedState.rounds[0].payments.filter((payment) => payment.adminConfirmed).length, 6);
    assert.equal(savedState.rounds[0].spins.length, 6);
    assert.equal(savedState.rounds[1].status, "open");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("serves the sidebar logo as a PNG image", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "make-money-logo-test-"));
  const app = createApp({
    dataFile: path.join(temporaryDirectory, "state.json"),
    adminEmail: "admin@example.com",
    adminPassword: "MasterAdmin123!"
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/make-money-logo.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 8)], [
      137, 80, 78, 71, 13, 10, 26, 10
    ]);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
