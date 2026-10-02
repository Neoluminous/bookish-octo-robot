(() => {
  const assessmentStorageKey = "ngo-compass-assessment";
  const draftStorageKey = "ngo-compass-assessment-draft";
  const supportUrl = "https://wa.me/919879547984?text=Hi%20Kuldeep%20ji%2C%20I%20need%20support%20with%20my%20NGO%20Funding%20Readiness%20Assessment.";
  const questions = window.NGO_COMPASS_QUESTIONS || [];
  const profileSteps = 5;
  const reviewStep = questions.length + profileSteps;
  const totalSteps = reviewStep + 1;
  const configuredBase = document.querySelector("base[href]")?.getAttribute("href") || "";
  const appRoot = (() => {
    try {
      return new URL(configuredBase || "/", location.href).pathname.replace(/\/?$/, "/");
    } catch {
      return location.pathname.replace(/(?:payment|assessment|privacy)\/?$/, "").replace(/\/?$/, "/");
    }
  })();
  const homeHref = appRoot;
  const apiUrl = `${appRoot}api.php`;
  const emptyDraft = () => ({
    profile: { respondentName: "", ngoName: "", email: "", phoneNumber: "", position: "" },
    answers: {},
    websiteUrl: "",
    driveLink: "",
    currentStep: 0,
    currentStepId: "profile_0",
    completed: false
  });
  let draft = emptyDraft();
  let token = null;
  let csrfToken = "";
  let orderReference = "";
  let settings = null;
  let saving = false;
  let status = "Your progress is saved on this device.";
  let remoteSaveTimer = 0;

  const sessionKey = "ngo-compass-session";
  const getSession = () => {
    try {
      const fromUrl = new URLSearchParams(location.search).get("session");
      if (fromUrl && /^[A-Za-z0-9_-]{16,128}$/.test(fromUrl)) {
        localStorage.setItem(sessionKey, fromUrl);
        return fromUrl;
      }
      return localStorage.getItem(sessionKey) || "";
    } catch {
      return "";
    }
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  const root = () => document.querySelector("main") || document.body;
  const isAssessment = () => /\/assessment\/?$/.test(location.pathname);
  const isPayment = () => /\/payment\/?$/.test(location.pathname);
  const isPrivacy = () => /\/privacy\/?$/.test(location.pathname);

  function getSelectedDriveItems() {
    const items = [];
    for (const q of questions) {
      if (q.driveItem && draft.answers[q.id] === "yes") {
        items.push({
          questionId: q.id,
          num: q.num,
          group: q.group,
          driveItem: q.driveItem,
          label: q.label
        });
      }
    }
    return items;
  }

  function getGroupedDriveItems() {
    const selected = getSelectedDriveItems();
    const groups = {};
    for (const item of selected) {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item.driveItem);
    }
    return groups;
  }

  function getActiveSteps() {
    const steps = [
      { id: "profile_0", type: "profile", index: 0, fieldKey: "respondentName" },
      { id: "profile_1", type: "profile", index: 1, fieldKey: "ngoName" },
      { id: "profile_2", type: "profile", index: 2, fieldKey: "email" },
      { id: "profile_3", type: "profile", index: 3, fieldKey: "phoneNumber" },
      { id: "profile_4", type: "profile", index: 4, fieldKey: "position" },
    ];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      steps.push({ id: q.id, type: "question", question: q, index: i });
      if (q.id === "q65" && draft.answers["q65"] === "yes") {
        steps.push({ id: "q65a", type: "website_url" });
      }
    }

    const driveItems = getSelectedDriveItems();
    if (driveItems.length > 0) {
      steps.push({ id: "q95", type: "drive_upload" });
    }

    steps.push({ id: "review", type: "review" });
    return steps;
  }

  function getCurrentStepInfo() {
    const steps = getActiveSteps();
    let idx = -1;
    if (draft.currentStepId) {
      idx = steps.findIndex(s => s.id === draft.currentStepId);
    }
    if (idx === -1) {
      idx = Math.max(0, Math.min(steps.length - 1, Number(draft.currentStep) || 0));
    }
    const current = steps[idx] || steps[0];
    draft.currentStep = idx;
    draft.currentStepId = current.id;
    return {
      step: current,
      index: idx,
      total: steps.length,
      steps
    };
  }

  const stage = () => {
    const { step } = getCurrentStepInfo();
    if (step.type === "profile") return "About your NGO";
    if (step.type === "question") return step.question.group || "Funding readiness";
    if (step.type === "website_url") return "Communication & Transparency";
    if (step.type === "drive_upload") return "Document Verification & Due Diligence Upload";
    if (step.type === "review") return "Review your answers";
    return "Funding readiness";
  };

  const progress = () => {
    if (draft.completed) return 100;
    const { index, total } = getCurrentStepInfo();
    return Math.min(100, Math.max(1, Math.round(((index + 1) / total) * 100)));
  };

  const answerLabel = (answer) => answer === "yes" ? "Yes" : answer === "no" ? "No" : answer === "not_applicable" ? "Not applicable" : answer === "not_sure" ? "Not sure" : "Not answered";
  const saveLocal = () => { localStorage.setItem(draftStorageKey, JSON.stringify(draft)); if (token) { localStorage.setItem(assessmentStorageKey, JSON.stringify(token)); if (!saving) { clearTimeout(remoteSaveTimer); remoteSaveTimer = window.setTimeout(() => saveRemote(draft, token, true).catch(() => { status = "Saved on this device (offline)."; const el = document.querySelector(".save-state"); if (el) el.textContent = status; }), 900); } } };

  function getCsrfCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)ngo_compass_csrf=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }

  async function request(payload, method = "POST") {
    if (!csrfToken) {
      csrfToken = getCsrfCookie();
    }
    const sessionToken = getSession();
    const headers = { "content-type": "application/json" };
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
    if (sessionToken) {
      headers["x-session-token"] = sessionToken;
      headers["x-access-token"] = sessionToken;
    }

    let url = apiUrl;
    const options = { method, credentials: "same-origin", headers };
    if (method === "GET") {
      const params = new URLSearchParams(payload || {});
      if (sessionToken && !params.has("session")) {
        params.set("session", sessionToken);
      }
      const qs = params.toString();
      if (qs) url = `${apiUrl}?${qs}`;
    } else {
      options.body = JSON.stringify({
        ...payload,
        csrfToken: csrfToken || payload?.csrfToken,
        sessionToken: sessionToken || payload?.sessionToken,
        session: sessionToken || payload?.session
      });
    }

    let response = await fetch(url, options);
    let data = await response.json().catch(() => ({}));
    if (response.status === 403 && method !== "GET") {
      try {
        await bootstrap();
        if (csrfToken) {
          options.headers["x-csrf-token"] = csrfToken;
          options.body = JSON.stringify({
            ...payload,
            csrfToken,
            sessionToken: sessionToken || payload?.sessionToken,
            session: sessionToken || payload?.session
          });
          response = await fetch(apiUrl, options);
          data = await response.json().catch(() => ({}));
        }
      } catch {}
    }
    if (data && data.csrfToken) {
      csrfToken = data.csrfToken;
    }
    const newCsrf = response.headers.get("x-csrf-token");
    if (newCsrf) {
      csrfToken = newCsrf;
    }
    if (!response.ok) {
      const error = new Error(data.error || "We could not save your progress.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function bootstrap() {
    const data = await request({ action: "bootstrap" }, "GET");
    settings = data.settings || null;
    csrfToken = data.csrfToken || getCsrfCookie() || "";
    orderReference = data.orderReference || settings?.orderReference || "";
  }

  function upiUri() { return settings?.upiUri || (settings?.upiId ? `upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(settings.payeeName || "NGO Compass")}&am=1999&cu=INR` : ""); }

  function renderPayment() {
    const query = new URLSearchParams(location.search);
    const invalidAccess = query.get("access") === "invalid";
    if (status === "submitted") { root().outerHTML = `<main class="payment-page"><section class="payment-card confirmation-card"><a class="assessment-brand" href="${homeHref}"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><div class="confirmation-icon" aria-hidden="true">✓</div><p class="eyebrow">Payment details received</p><h1>Thank you.</h1><p>We’ve received your payment information. Once it is verified, we’ll provide access to your funding-readiness assessment.</p><a class="support-link" href="${supportUrl}" target="_blank" rel="noreferrer">Facing an issue? Contact us on WhatsApp <span aria-hidden="true">→</span></a></section></main>`; return; }
    if (!settings?.available) { root().outerHTML = `<main class="payment-page"><section class="payment-card"><header class="payment-header"><a class="assessment-brand" href="${homeHref}"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><span class="payment-secure">Secure UPI payment</span></header><div class="payment-intro"><p class="eyebrow">Funding readiness assessment</p><h1>Payment details are being set up</h1><p>Our UPI payment details are not available right now. Please contact us on WhatsApp and we’ll help you complete your payment.</p><a class="primary-cta" href="${supportUrl}" target="_blank" rel="noreferrer">Contact support on WhatsApp <span aria-hidden="true">→</span></a></div></section></main><p class="payment-support">Need help? <a href="${supportUrl}" target="_blank" rel="noreferrer">Contact us on WhatsApp</a></p>`; return; }
    const saved = JSON.parse(localStorage.getItem("ngo-compass-payment-draft") || "null") || { respondentName: "", ngoName: "", email: "", phoneNumber: "", utr: "", consent: false, proof: null };
    root().outerHTML = `<main class="payment-page"><section class="payment-card"><header class="payment-header"><a class="assessment-brand" href="./"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><span class="payment-secure">Secure UPI payment</span></header><div class="payment-intro"><p class="eyebrow">Funding readiness assessment</p><h1>Complete your payment</h1><p>Pay the one-time assessment fee, then share the payment reference below so our team can confirm your access.</p></div><div class="payment-amount"><div><span class="payment-amount-label">One-time fee</span><strong>₹1,999</strong></div><span class="payment-amount-note">No recurring charges</span></div>${invalidAccess ? '<p class="form-error" role="alert">That access link is invalid or has already been used. Please contact support if you need help.</p>' : ''}<div class="payee-panel"><div class="qr-wrap">${settings.qrDataUrl ? `<img src="${escapeHtml(settings.qrDataUrl)}" alt="UPI payment QR for ${escapeHtml(settings.payeeName)}">` : '<div class="qr-placeholder" data-qr-placeholder>Generating QR…</div>'}</div><div class="payee-details"><p class="payment-label">Pay to</p><h2>${escapeHtml(settings.payeeName || "NGO Compass")}</h2>${settings.upiId ? `<div class="upi-row"><span>UPI ID</span><strong>${escapeHtml(settings.upiId)}</strong><button type="button" class="copy-button" data-copy="${escapeHtml(settings.upiId)}">Copy</button></div>` : ""}${settings.upiPhone ? `<div class="upi-row"><span>UPI-linked phone</span><strong>${escapeHtml(settings.upiPhone)}</strong></div>` : ""}<a class="upi-open" href="${escapeHtml(upiUri())}">Open in a UPI app <span aria-hidden="true">↗</span></a></div></div><form class="payment-form" data-payment-form><div class="payment-form-heading"><p class="eyebrow">After payment</p><h2>Share your payment details</h2><p>Use the same name and NGO details you want associated with your assessment.</p></div><div class="payment-fields"><label class="field-label" for="payment-name">Your name</label><input id="payment-name" required autocomplete="name" value="${escapeHtml(saved.respondentName)}"><label class="field-label" for="payment-ngo">NGO name</label><input id="payment-ngo" required value="${escapeHtml(saved.ngoName)}"><label class="field-label" for="payment-email">Email address</label><input id="payment-email" required type="email" autocomplete="email" value="${escapeHtml(saved.email)}"><label class="field-label" for="payment-phone">Mobile number</label><input id="payment-phone" required type="tel" autocomplete="tel" inputmode="tel" value="${escapeHtml(saved.phoneNumber)}"><label class="field-label" for="payment-utr">UPI transaction reference / UTR</label><input id="payment-utr" required value="${escapeHtml(saved.utr)}" placeholder="Enter your transaction reference"><label class="field-label" for="payment-proof">Payment proof <span>(optional)</span></label><input id="payment-proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><p class="field-hint">JPG, PNG, WEBP or PDF up to 5 MB.</p></div><label class="consent-check"><input id="payment-consent" type="checkbox" required ${saved.consent ? "checked" : ""}><span>I confirm that these payment details are accurate and consent to NGO Compass using them to verify my payment and provide assessment access.</span></label><p class="form-error" role="alert" hidden></p><button class="continue-button payment-submit" type="submit">Submit payment details <span aria-hidden="true">→</span></button></form></section><p class="payment-support">Need help? <a href="${supportUrl}" target="_blank" rel="noreferrer">Contact us on WhatsApp</a></p></main>`;
    document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => {
      const copyVal = button.dataset.copy || "";
      if (!copyVal) return;
      navigator.clipboard?.writeText(copyVal).then(() => {
        const orig = button.textContent;
        button.textContent = "Copied! ✓";
        setTimeout(() => { button.textContent = orig; }, 2000);
      }).catch(() => {});
    }));
    if (!settings.qrDataUrl && settings.upiId && window.QRCode?.toDataURL) window.QRCode.toDataURL(upiUri(), { width: 220, margin: 2, color: { dark: "#063d25", light: "#ffffff" } }).then((source) => { const placeholder = document.querySelector("[data-qr-placeholder]"); if (placeholder) placeholder.outerHTML = `<img src="${source}" alt="UPI payment QR for ${escapeHtml(settings.payeeName)}">`; }).catch(() => { const placeholder = document.querySelector("[data-qr-placeholder]"); if (placeholder) placeholder.textContent = "Use the UPI ID below"; });
    const paymentForm = document.querySelector("[data-payment-form]");
    paymentForm?.querySelectorAll("input, textarea").forEach((input) => {
      input.addEventListener("input", () => localStorage.setItem("ngo-compass-payment-draft", JSON.stringify(readPaymentForm())));
      input.addEventListener("change", () => localStorage.setItem("ngo-compass-payment-draft", JSON.stringify(readPaymentForm())));
    });
    paymentForm?.addEventListener("submit", (event) => { event.preventDefault(); void submitPayment(); });
  }

  function readPaymentForm() { const value = (id) => document.querySelector(id)?.value?.trim() || ""; const file = document.querySelector("#payment-proof")?.files?.[0]; return { orderReference, respondentName: value("#payment-name"), ngoName: value("#payment-ngo"), email: value("#payment-email"), phoneNumber: value("#payment-phone"), utr: value("#payment-utr"), consent: Boolean(document.querySelector("#payment-consent")?.checked), proof: file ? { name: file.name, type: file.type, size: file.size, data: "" } : null }; }
  async function submitPayment() {
    const form = readPaymentForm(); const error = document.querySelector(".payment-form .form-error"); const proofFile = document.querySelector("#payment-proof")?.files?.[0];
    const show = (message) => { if (error) { error.hidden = false; error.textContent = message; error.scrollIntoView?.({ behavior: "smooth", block: "center" }); } };
    if (form.respondentName.length < 2) return show("Please enter your name (at least 2 characters).");
    if (form.ngoName.length < 2) return show("Please enter your NGO name (at least 2 characters).");
    if (!form.email || !/^\S+@\S+\.\S+$/.test(form.email)) return show("Please enter a valid email address.");
    if (!form.phoneNumber || !/^[+()\-\s\d]{7,24}$/.test(form.phoneNumber)) return show("Please enter a valid mobile number (at least 7 digits).");
    if (!form.utr || form.utr.length < 6) return show("Please enter your UPI transaction reference / UTR (at least 6 characters).");
    if (!form.consent) return show("Please confirm and accept the consent checkbox to continue.");
    if (proofFile) {
      const validExt = /\.(jpe?g|png|webp|pdf)$/i.test(proofFile.name);
      const validMime = ["image/jpeg", "image/png", "image/webp", "application/pdf", ""].includes(proofFile.type);
      if ((!validExt && !validMime) || proofFile.size > 5000000) return show("Upload a JPG, PNG, WEBP or PDF under 5 MB.");
      form.proof.data = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => resolve(""); reader.readAsDataURL(proofFile); });
      if (!form.proof.data) return show("We could not read that file. Please try again.");
    }
    saving = true; const submit = document.querySelector(".payment-submit"); if (submit) { submit.disabled = true; submit.textContent = "Submitting details…"; } if (error) error.hidden = true;
    try { await request({ action: "payment", ...form }); localStorage.removeItem("ngo-compass-payment-draft"); status = "submitted"; renderPayment(); } catch (caught) { show(caught.message || "We could not record your payment details. Please try again."); if (caught.status === 403) { try { await bootstrap(); } catch {} } } finally { saving = false; if (submit) { submit.disabled = false; submit.innerHTML = 'Submit payment details <span aria-hidden="true">→</span>'; } }
  }

  async function beginAssessment() { const data = await request({ action: "start", profile: draft.profile }); token = { id: data.id, respondentKey: data.respondentKey }; saveLocal(); return token; }
  async function saveRemote(nextDraft, nextToken, silent = false) {
    if (!silent) { saving = true; status = "Saving securely…"; renderAssessment(); }
    await request({ action: "save", ...nextToken, draft: nextDraft });
    status = nextDraft.completed ? "Assessment submitted." : "Saved securely.";
    const el = document.querySelector(".save-state");
    if (el) el.textContent = status;
    if (!silent) { saving = false; renderAssessment(); }
  }
  function isValidWebsiteUrl(val) {
    if (!val) return false;
    const str = String(val).trim();
    if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(str)) return true;
    if (/^(www\.)?[a-zA-Z0-9][-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{2,10}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/i.test(str)) return true;
    return false;
  }

  function isValidDriveUrl(val) {
    if (!val) return false;
    const str = String(val).trim();
    return /^(https?:\/\/)?([a-zA-Z0-9-]+\.)*(drive\.google\.com|docs\.google\.com)\/.+$/i.test(str);
  }

  function currentQuestion() {
    const { step } = getCurrentStepInfo();
    return step?.type === "question" ? step.question : null;
  }

  function renderAssessment() {
    if (draft.completed) {
      root().outerHTML = `<main class="assessment-page"><section class="thank-you-card"><a class="assessment-brand" href="./"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><div class="confirmation-icon" aria-hidden="true">✓</div><p class="eyebrow">Assessment complete</p><h1>Thank you.</h1><p>Our team will send you your funding-readiness report in 3 working days.</p><a class="support-link" href="${supportUrl}" target="_blank" rel="noreferrer">Facing an issue? Contact us on WhatsApp <span aria-hidden="true">→</span></a></section></main>`;
      return;
    }

    const { step, index, total, steps } = getCurrentStepInfo();
    let kicker = stage();
    let badge = "";
    let prompt = "";
    let helper = "";
    let privacy = "";
    let bodyContent = "";
    let actionsHtml = "";

    const hasBack = index > 0;
    const backBtn = hasBack ? '<button class="back-button" type="button" data-back>Back</button>' : '';

    if (step.type === "profile") {
      const respName = escapeHtml(draft.profile.respondentName.trim());
      const ngoName = escapeHtml(draft.profile.ngoName.trim());

      if (step.index === 0) {
        kicker = "Let’s get acquainted";
        badge = "Question 1";
        prompt = "What is your full name?";
        helper = "Typically takes 8–10 minutes. You can pause at any time and come back to this device.";
        bodyContent = `<label class="field-label" for="answer">Your name</label><input id="answer" type="text" autocomplete="name" value="${escapeHtml(draft.profile.respondentName)}" placeholder="Enter your name">`;
      } else if (step.index === 1) {
        kicker = "Start with your NGO";
        badge = "Question 2";
        prompt = `Hi ${respName || "there"} 👋<br>What is your NGO’s legal or registered name?`;
        bodyContent = `<label class="field-label" for="answer">NGO name</label><input id="answer" type="text" value="${escapeHtml(draft.profile.ngoName)}" placeholder="Enter your NGO’s legal or registered name">`;
      } else if (step.index === 2) {
        kicker = "Your official email";
        badge = "Question 3";
        prompt = "What is your official work email address?";
        privacy = 'We use your details only to prepare and send your funding-readiness report. <a href="./privacy/">Read our privacy note.</a>';
        bodyContent = `<label class="field-label" for="answer">Email address</label><input id="answer" type="email" inputmode="email" autocomplete="email" value="${escapeHtml(draft.profile.email)}" placeholder="name@organisation.org">`;
      } else if (step.index === 3) {
        kicker = "How can we reach you?";
        badge = "Question 4";
        prompt = "What is your phone / WhatsApp number?";
        bodyContent = `<label class="field-label" for="answer">Phone / WhatsApp number</label><input id="answer" type="tel" inputmode="tel" autocomplete="tel" value="${escapeHtml(draft.profile.phoneNumber)}" placeholder="Enter your phone or WhatsApp number">`;
      } else if (step.index === 4) {
        kicker = "Your role in the NGO";
        badge = "Question 5";
        prompt = `What is your designation or role at ${ngoName || "your NGO"}?`;
        bodyContent = `<label class="field-label" for="answer">Your designation / role</label><input id="answer" type="text" value="${escapeHtml(draft.profile.position)}" placeholder="For example: Founder, Trustee, Director, Program Manager">`;
      }

      actionsHtml = `${backBtn}<button class="continue-button" type="button" data-continue ${saving ? "disabled" : ""}>Continue <span aria-hidden="true">→</span></button>`;
    } else if (step.type === "question") {
      const q = step.question;
      kicker = q.group || "Funding readiness";
      badge = `Question ${q.num}`;
      prompt = escapeHtml(q.prompt || `Does your NGO have ${q.label}?`);
      helper = "Choose the answer that reflects your NGO’s current position.";

      const answers = ["yes", "no", "not_applicable"];
      const currentAns = draft.answers[q.id];
      actionsHtml = `${backBtn}<div class="answer-buttons" role="group" aria-label="Choose an answer">${answers.map((answer) => `<button class="answer-button ${answer} ${answer.replace(/_/g, "-")} ${currentAns === answer ? "selected" : ""}" type="button" data-answer="${answer}" aria-pressed="${currentAns === answer}" ${saving ? "disabled" : ""}>${answerLabel(answer)}</button>`).join("")}</div>`;
    } else if (step.type === "website_url") {
      kicker = "Communication & Transparency";
      badge = "Question 70a";
      prompt = `Please share your NGO's website URL:`;
      helper = "Enter your NGO's active website address (e.g. https://www.yourngo.org or www.yourngo.org).";
      bodyContent = `<label class="field-label" for="answer">Website URL</label><input id="answer" type="url" inputmode="url" autocomplete="url" value="${escapeHtml(draft.websiteUrl || draft.answers["q65a"] || "")}" placeholder="https://www.yourngo.org">`;
      actionsHtml = `${backBtn}<button class="continue-button" type="button" data-continue ${saving ? "disabled" : ""}>Continue <span aria-hidden="true">→</span></button>`;
    } else if (step.type === "drive_upload") {
      kicker = "Document Verification & Due Diligence Upload";
      badge = "Question 95";
      prompt = `Upload your compliance documents to Google Drive`;
      helper = "Based on your <strong>\"Yes\"</strong> responses, please upload the following documents to a Google Drive folder (ensure link sharing is set to <strong>\"Anyone with the link can view\"</strong>) and paste the Google Drive folder link below:";

      const grouped = getGroupedDriveItems();
      const selectedCount = getSelectedDriveItems().length;
      let checklistHtml = '<div class="drive-checklist">';
      checklistHtml += `<div class="drive-checklist-header">📁 Documents to include in your Google Drive folder (${selectedCount} item${selectedCount === 1 ? '' : 's'})</div>`;
      for (const [groupName, items] of Object.entries(grouped)) {
        checklistHtml += `<div class="drive-section">`;
        checklistHtml += `<h4 class="drive-section-title">${escapeHtml(groupName)}</h4>`;
        checklistHtml += `<ul class="drive-item-list">`;
        for (const item of items) {
          checklistHtml += `<li class="drive-item"><span class="drive-item-bullet" aria-hidden="true">✓</span> <span>${escapeHtml(item)}</span></li>`;
        }
        checklistHtml += `</ul></div>`;
      }
      checklistHtml += `</div>`;
      checklistHtml += `<div class="drive-tip-box"><span class="drive-tip-icon" aria-hidden="true">💡</span><p><strong>Tip:</strong> Organize your Drive folder into subfolders matching the section names above for faster donor due diligence verification.</p></div>`;

      bodyContent = `${checklistHtml}<label class="field-label" for="answer">Google Drive Folder Link</label><input id="answer" type="url" inputmode="url" autocomplete="off" value="${escapeHtml(draft.driveLink || draft.answers["driveLink"] || "")}" placeholder="https://drive.google.com/drive/folders/...">`;
      actionsHtml = `${backBtn}<button class="continue-button" type="button" data-continue ${saving ? "disabled" : ""}>Continue to review <span aria-hidden="true">→</span></button>`;
    } else if (step.type === "review") {
      kicker = "Ready to submit?";
      const complianceCount = Object.keys(draft.answers).filter(k => k.startsWith("q") && !k.endsWith("a")).length;
      const driveItems = getSelectedDriveItems();

      let reviewSummary = `<div class="review-summary">`;
      reviewSummary += `<div><span>Name</span><strong>${escapeHtml(draft.profile.respondentName)}</strong></div>`;
      reviewSummary += `<div><span>NGO</span><strong>${escapeHtml(draft.profile.ngoName)}</strong></div>`;
      reviewSummary += `<div><span>Email</span><strong>${escapeHtml(draft.profile.email)}</strong></div>`;
      reviewSummary += `<div><span>Phone</span><strong>${escapeHtml(draft.profile.phoneNumber)}</strong></div>`;
      reviewSummary += `<div><span>Position</span><strong>${escapeHtml(draft.profile.position)}</strong></div>`;
      if (draft.websiteUrl) {
        reviewSummary += `<div><span>Website URL</span><strong><a href="${escapeHtml(draft.websiteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(draft.websiteUrl)} ↗</a></strong></div>`;
      }
      if (draft.driveLink) {
        reviewSummary += `<div><span>Google Drive Link</span><strong><a href="${escapeHtml(draft.driveLink)}" target="_blank" rel="noopener noreferrer" class="review-drive-link">📂 Open Folder (${driveItems.length} documents) ↗</a></strong></div>`;
      }
      reviewSummary += `<div><span>Compliance checks answered</span><strong>${complianceCount} of ${questions.length}</strong></div>`;
      reviewSummary += `</div>`;

      bodyContent = `<h1>Review your answers</h1><p class="assessment-helper">Check your details before submitting. You can go back to make changes.</p>${reviewSummary}`;
      actionsHtml = `${backBtn}<button class="continue-button" type="button" data-submit ${saving ? "disabled" : ""}>${saving ? "Submitting…" : "Submit assessment"} <span aria-hidden="true">→</span></button>`;
    }

    const badgeHtml = badge ? `<div class="q-badge-wrap"><span class="q-badge">${escapeHtml(badge)}</span></div>` : "";
    const headerTitle = step.type === "review" ? "" : `<h1>${prompt}</h1>`;
    const helperHtml = helper && step.type !== "review" ? `<p class="assessment-helper">${helper}</p>` : "";
    const privacyHtml = privacy ? `<p class="form-privacy">${privacy}</p>` : "";

    root().outerHTML = `<main class="assessment-page"><section class="assessment-shell"><div class="assessment-topbar"><a class="assessment-brand" href="./"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><div class="assessment-status"><span class="save-state" aria-live="polite">${saving ? "Saving securely…" : escapeHtml(status)}</span>${token ? '<button class="restart-button" type="button" data-restart>Start a new assessment</button>' : ""}</div></div><div class="assessment-progress" role="progressbar" aria-label="Funding readiness assessment progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress()}"><span style="width:${progress()}%"></span></div><p class="assessment-stage">${escapeHtml(kicker)}</p><div class="assessment-content"><p class="assessment-kicker">${escapeHtml(kicker)}</p>${badgeHtml}${headerTitle}${helperHtml}${privacyHtml}${bodyContent}${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : '<p class="form-error" role="alert" hidden></p>'}<div class="assessment-actions">${actionsHtml}</div></div></section></main>`;
    bindAssessment();
  }

  let error = "";

  async function forward(answer) {
    if (saving) return;
    error = "";
    const { step, index, total, steps } = getCurrentStepInfo();

    if (step.type === "review") {
      const next = { ...draft, completed: true };
      saving = true;
      status = "Submitting securely…";
      renderAssessment();
      try {
        const active = token || await beginAssessment();
        await saveRemote(next, active, true);
        draft = next;
        saveLocal();
        saving = false;
        renderAssessment();
      } catch (caught) {
        saving = false;
        error = caught.message || "We could not submit your assessment. Please try again.";
        status = "Not submitted yet. Your answers are still here.";
        renderAssessment();
      }
      return;
    }

    if (step.type === "profile") {
      const inputEl = document.querySelector("#answer");
      const val = inputEl?.value?.trim() || "";
      draft.profile[step.fieldKey] = val;
      if (val.length < 2) {
        error = "Please enter your answer (at least 2 characters).";
        renderAssessment();
        return;
      }
      if (step.fieldKey === "email" && !/^\S+@\S+\.\S+$/.test(val)) {
        error = "Please enter a valid email address.";
        renderAssessment();
        return;
      }
      if (step.fieldKey === "phoneNumber" && !/^[+()\-\s\d]{7,24}$/.test(val)) {
        error = "Please enter a valid phone number (at least 7 digits).";
        renderAssessment();
        return;
      }
    } else if (step.type === "question") {
      if (!answer) {
        error = "Please choose an answer to continue.";
        renderAssessment();
        return;
      }
      draft.answers[step.question.id] = answer;
    } else if (step.type === "website_url") {
      const inputEl = document.querySelector("#answer");
      const val = inputEl?.value?.trim() || "";
      if (!isValidWebsiteUrl(val)) {
        error = "Please enter a valid website URL or domain (accepting https://, http://, or www. formats).";
        renderAssessment();
        return;
      }
      draft.websiteUrl = val;
      draft.answers["q65a"] = val;
    } else if (step.type === "drive_upload") {
      const inputEl = document.querySelector("#answer");
      const val = inputEl?.value?.trim() || "";
      if (!isValidDriveUrl(val)) {
        error = "Please enter a valid Google Drive link (must contain drive.google.com or docs.google.com).";
        renderAssessment();
        return;
      }
      draft.driveLink = val;
      draft.answers["driveLink"] = val;
    }

    const nextSteps = getActiveSteps();
    const currentIdxInNext = nextSteps.findIndex(s => s.id === step.id);
    const nextIdx = currentIdxInNext >= 0 ? currentIdxInNext + 1 : index + 1;
    const nextStep = nextSteps[Math.min(nextSteps.length - 1, nextIdx)];

    draft.currentStepId = nextStep.id;
    draft.currentStep = nextIdx;
    draft.completed = false;
    saveLocal();
    error = "";
    status = "Saved on this device.";
    renderAssessment();

    if (token) {
      saveRemote(draft, token, true).catch(() => {
        status = "Saved on this device (offline).";
        const el = document.querySelector(".save-state");
        if (el) el.textContent = status;
      });
    } else if (draft.currentStep >= 1) {
      beginAssessment()
        .then((active) => saveRemote(draft, active, true))
        .catch(() => {
          status = "Saved on this device.";
          const el = document.querySelector(".save-state");
          if (el) el.textContent = status;
        });
    }
  }

  function bindAssessment() {
    document.querySelector("[data-continue]")?.addEventListener("click", () => void forward());
    document.querySelector("[data-submit]")?.addEventListener("click", () => void forward());
    document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => void forward(button.dataset.answer)));
    document.querySelector("[data-back]")?.addEventListener("click", () => {
      if (!saving) {
        const { index, steps } = getCurrentStepInfo();
        if (index > 0) {
          const prevStep = steps[index - 1];
          draft.currentStepId = prevStep.id;
          draft.currentStep = index - 1;
          error = "";
          renderAssessment();
        }
      }
    });
    let restartPending = false;
    let restartTimer = 0;
    const restartBtn = document.querySelector("[data-restart]");
    restartBtn?.addEventListener("click", () => {
      if (saving) return;
      if (!restartPending) {
        restartPending = true;
        restartBtn.textContent = "Click again to confirm reset";
        clearTimeout(restartTimer);
        restartTimer = window.setTimeout(() => {
          restartPending = false;
          if (restartBtn) restartBtn.textContent = "Start a new assessment";
        }, 4000);
        return;
      }
      clearTimeout(restartTimer);
      localStorage.removeItem(assessmentStorageKey);
      localStorage.removeItem(draftStorageKey);
      token = null;
      draft = emptyDraft();
      status = "Your progress is saved on this device.";
      renderAssessment();
    });
    const input = document.querySelector("#answer");
    if (input) {
      input.focus();
      try {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } catch {}
      input.addEventListener("input", () => {
        const { step } = getCurrentStepInfo();
        if (step.type === "profile") {
          draft.profile[step.fieldKey] = input.value;
        } else if (step.type === "website_url") {
          draft.websiteUrl = input.value;
          draft.answers["q65a"] = input.value;
        } else if (step.type === "drive_upload") {
          draft.driveLink = input.value;
          draft.answers["driveLink"] = input.value;
        }
        saveLocal();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void forward();
        }
      });
    } else if (currentQuestion()) {
      const onKey = (event) => {
        if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
        if (saving) return;
        const k = event.key.toLowerCase();
        if (k === "1" || k === "y") {
          event.preventDefault();
          void forward("yes");
        } else if (k === "2" || k === "n") {
          event.preventDefault();
          void forward("no");
        } else if (k === "3" || k === "a") {
          event.preventDefault();
          void forward("not_applicable");
        } else if (k === "arrowleft") {
          const { index, steps } = getCurrentStepInfo();
          if (index > 0) {
            event.preventDefault();
            draft.currentStepId = steps[index - 1].id;
            draft.currentStep = index - 1;
            error = "";
            renderAssessment();
          }
        }
      };
      window.addEventListener("keydown", onKey, { once: true });
    }
  }
  async function restoreAssessment() {
    try {
      const storedDraft = JSON.parse(localStorage.getItem(draftStorageKey) || "null");
      if (storedDraft?.profile && storedDraft.answers) draft = storedDraft;
      token = JSON.parse(localStorage.getItem(assessmentStorageKey) || "null");
      if (!token?.id || !token?.respondentKey) {
        token = null;
        return;
      }
      const data = await request({ action: "load", id: token.id, key: token.respondentKey }, "GET");
      if (data?.assessment) {
        draft = data.assessment;
        status = draft.completed ? "Assessment submitted." : "Your saved assessment is ready to continue.";
      }
    } catch {
      status = "Loaded from this device. Your progress is safe.";
    }
  }
  function renderPrivacy() { root().outerHTML = `<main class="simple-page"><section class="simple-card"><a class="assessment-brand" href="./"><img src="./ngo-compass-logo.png" alt="NGO Compass"></a><p class="eyebrow">Privacy note</p><h1>Your information, used responsibly.</h1><p>We collect the details you submit to verify your payment, provide access to the funding-readiness assessment and prepare your report.</p><div class="simple-copy"><h2>What we collect</h2><p>Your name, NGO name, email address, phone number, payment reference and any optional payment proof you choose to upload.</p><h2>How we use it</h2><p>Our team uses this information to match your payment, manage assessment access, review your answers and contact you about the report or support request.</p><h2>How long we keep it</h2><p>We retain submitted information for operational, accounting and support purposes. You can request access, correction or deletion by contacting our support team on WhatsApp.</p><h2>Questions</h2><p>For privacy or payment questions, <a class="text-link" href="${supportUrl}" target="_blank" rel="noreferrer">contact us on WhatsApp</a>.</p></div><a class="back-button simple-back" href="./payment/">Back to payment</a></section></main>`; }
  function normalizeNestedLinks() { document.querySelectorAll('a[href="./"]').forEach((link) => { link.setAttribute("href", homeHref); }); document.querySelectorAll('a[href="./privacy/"]').forEach((link) => { link.setAttribute("href", `${appRoot}privacy/`); }); document.querySelectorAll('a[href="./payment/"]').forEach((link) => { link.setAttribute("href", `${appRoot}payment/`); }); document.querySelectorAll('a[href="./admin"]').forEach((link) => { link.setAttribute("href", `${appRoot}admin`); }); }
  function setupLanding() { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; const elements = [...document.querySelectorAll("[data-reveal]")]; if (!elements.length) return; document.documentElement.classList.add("reveal-ready"); const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); } }), { rootMargin: "0px 0px -8%", threshold: 0.08 }); elements.forEach((element) => observer.observe(element)); }
  let initialLandingHtml = "";
  if (!isPayment() && !isAssessment() && !isPrivacy()) {
    initialLandingHtml = root().innerHTML;
  }
  async function boot() {
    if (isPayment()) {
      try { await bootstrap(); } catch { settings = null; }
      renderPayment();
      normalizeNestedLinks();
      return;
    }
    if (isAssessment()) {
      try { await bootstrap(); } catch {}
      const session = getSession();
      const storedToken = JSON.parse(localStorage.getItem(assessmentStorageKey) || "null");
      const storedDraft = JSON.parse(localStorage.getItem(draftStorageKey) || "null");

      let hasAccess = false;
      if (session) {
        try {
          const acc = await request({ action: "access" }, "GET");
          if (acc?.ok || acc?.access) hasAccess = true;
        } catch {}
      }

      if (!hasAccess && !storedToken?.id && !storedDraft?.profile?.respondentName && !session) {
        location.assign(`${appRoot || "/"}payment/`);
        return;
      }
      await restoreAssessment();
      renderAssessment();
      normalizeNestedLinks();
      return;
    }
    if (isPrivacy()) {
      renderPrivacy();
      normalizeNestedLinks();
      return;
    }
    if (initialLandingHtml && (root().classList.contains("payment-page") || root().classList.contains("assessment-page") || root().classList.contains("simple-page"))) {
      root().className = "";
      root().innerHTML = initialLandingHtml;
      normalizeNestedLinks();
    }
    setupLanding();
  }
  document.addEventListener("click", (event) => {
    const anchor = event.target.closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (
      anchor.target === "_blank" ||
      href.startsWith("http://") ||
      href.startsWith("https://") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("whatsapp:") ||
      anchor.hasAttribute("download") ||
      href.includes("/admin") ||
      href.endsWith("admin")
    ) {
      return;
    }
    event.preventDefault();
    try {
      const targetUrl = new URL(anchor.href, location.href);
      if (targetUrl.href !== location.href) {
        history.pushState({}, "", targetUrl.href);
      }
      window.scrollTo(0, 0);
      void boot();
    } catch {
      location.assign(anchor.href);
    }
  });
  addEventListener("popstate", boot);
  boot();
})();
