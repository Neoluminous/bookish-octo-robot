(() => {
  const rootPath = new URL(document.querySelector('base')?.href || '/FundingReady/', location.href).pathname;
  const api = `${rootPath}api.php`;
  const questions = window.NGO_COMPASS_QUESTIONS || [];
  const support = 'https://wa.me/919879547984?text=Hi%2C%20I%20need%20help%20with%20my%20Funding%20Ready%20assessment.';
  const assessmentKey = 'ngo-compass-assessment-v2';
  const paymentKey = 'ngo-compass-payment-reference';
  const profileFields = [
    ['respondentName','Your name','text'], ['ngoName','NGO name','text'], ['email','Work email address','email'], ['phoneNumber','Phone number','tel'], ['position','Your position','text'],
  ];
  const blank = () => ({ profile: Object.fromEntries(profileFields.map(([key]) => [key,''])), answers: {}, naReasons: {}, currentStepId: 'profile_1', completed: false });
  let draft = blank(), assessmentId = '', revision = 0, csrf = '', settings = {}, reviewerEmail = '', paymentReference = '';
  let receipt = null, dirty = false, busy = false, conflict = false, saveQueue = Promise.resolve(), saveTimer = 0, saveState = 'Ready to begin', error = '', fieldErrors = {};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const main = () => document.querySelector('main');
  const replace = html => { main().outerHTML = html; };
  const brand = `<a class="assessment-brand" href="${rootPath}"><img src="${rootPath}ngo-compass-logo.png" alt="NGO Compass"></a>`;
  const labels = {yes:'Yes',no:'No',not_applicable:'Not applicable'};
  const idStep = id => {
    if (id === 'profile') return 'profile_1';
    if (id === 'context') return 'q1';
    if (/^profile_[1-5]$/.test(id) || id === 'review') return id;
    const previousQuestion = /^q(8|45|53|60|62)_/.exec(id || '');
    const next = previousQuestion ? `q${previousQuestion[1]}` : id;
    return questions.some(q => q.id === next) ? next : 'profile_1';
  };
  const activeQuestions = () => questions;
  const steps = () => [...profileFields.map((_, index) => `profile_${index+1}`),...questions.map(q => q.id),'review'];
  const currentStep = () => idStep(draft.currentStepId);
  function store() { localStorage.setItem(assessmentKey, JSON.stringify({draft, assessmentId, revision, dirty, at:Date.now()})); }
  function mutate(change) { draft = {...draft,...change}; dirty = true; store(); saveState = 'Saving…'; renderAssessment(); scheduleSave(); }
  async function get(action, extra = {}) { const response = await fetch(`${api}?${new URLSearchParams({action,...extra})}`, {credentials:'same-origin'}); return readResponse(response); }
  async function post(action, body) { const response = await fetch(api, {method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action,...body})}); return readResponse(response); }
  async function readResponse(response) { const data = await response.json().catch(() => ({})); if (!response.ok) {const failure = new Error(data.error || 'Request failed.'); failure.status=response.status; failure.fields=data.fields || {}; failure.revision=data.revision; throw failure;} return data; }
  async function bootstrap() {const data=await get('bootstrap'); csrf=data.csrfToken; settings=data.settings || {}; reviewerEmail=data.reviewerEmail || ''; return data;}
  async function ensureAssessment() {if (assessmentId) return assessmentId; const data=await post('start',{profile:draft.profile}); assessmentId=data.id; revision=data.revision || 0; store(); return assessmentId;}
  function save(snapshot = structuredClone(draft)) {
    const job = async () => {
      await ensureAssessment(); saveState='Saving…'; updateSaveState();
      try {
        const result = await post('save',{id:assessmentId,revision,draft:snapshot});
        revision=result.revision; if (JSON.stringify(snapshot) === JSON.stringify(draft)) {dirty=false; saveState=snapshot.completed?'Submitted':'Saved'; store();} updateSaveState(); return result;
      } catch (failure) {saveState='Save failed. Your answers remain on this device.'; error=failure.message; fieldErrors=failure.fields || {}; if (failure.status===409) conflict=true; updateSaveState(); renderAssessment(); throw failure;}
    };
    const pending=saveQueue.then(job,job); saveQueue=pending.catch(()=>{}); return pending;
  }
  function scheduleSave() {clearTimeout(saveTimer); if (!assessmentId || draft.completed || conflict) return; saveTimer=setTimeout(()=>save().catch(()=>{}),1000);}
  function updateSaveState() {const el=document.querySelector('.save-state'); if (el) el.textContent=saveState;}
  async function loadAssessment(id) {const result=await get('load',{id}); return result;}
  async function initAssessment() {
    replace(`<main class="assessment-page"><section class="assessment-shell assessment-loading">Loading saved progress…</section></main>`);
    let access; try {access=await bootstrap();} catch {replace(`<main class="assessment-page"><section class="assessment-shell" role="alert">Assessment service is unavailable. Please try again later.</section></main>`);return;}
    if (!access.access) {location.assign(`${rootPath}payment/`);return;}
    let local=null; try {local=JSON.parse(localStorage.getItem(assessmentKey)||'null');} catch {}
    if (!local) {try {const prior=JSON.parse(localStorage.getItem('ngo-compass-assessment-draft')||'null'); const token=JSON.parse(localStorage.getItem('ngo-compass-assessment')||'null');if(prior?.profile&&prior?.answers) local={draft:{...blank(),...prior,profile:{...blank().profile,...prior.profile},naReasons:{}},assessmentId:token?.id||'',revision:0,dirty:true};}catch{}}
    if (local?.assessmentId) {
      try {
        const remote=await loadAssessment(local.assessmentId); assessmentId=local.assessmentId; revision=remote.assessment.revision||0; receipt=remote.receipt;
        const remoteDraft={...blank(),...remote.assessment,profile:{...blank().profile,...remote.assessment.profile},naReasons:remote.assessment.naReasons||{}};
        if (local.dirty && local.revision !== revision && !remoteDraft.completed) {draft=local.draft; dirty=true; conflict=true; saveState='Local and server drafts differ.';}
        else if (local.dirty && !remoteDraft.completed) {draft=local.draft;dirty=true;saveState='Saving local changes…';}
        else {draft=remoteDraft;dirty=false;saveState=draft.completed?'Submitted':'Saved';store();}
      } catch(failure) { if (failure.status===403) {location.assign(`${rootPath}payment/`);return;} draft=local.draft||blank(); assessmentId=local.assessmentId; dirty=true; saveState='Save failed. Local answers retained.'; }
    } else if(local?.draft) {draft=local.draft;dirty=true;saveState='Local draft restored.';}
    draft.currentStepId=idStep(draft.currentStepId);
    if (!steps().includes(draft.currentStepId)) draft.currentStepId='profile_1';
    if (draft.completed) renderAssessment();
    else if (local?.draft) renderResume();
    else renderAssessment();
    if(dirty&&!conflict) scheduleSave();
  }
  function renderResume() {
    replace(`<main class="assessment-page"><section class="assessment-shell"><div class="assessment-topbar">${brand}<span class="save-state" role="status" aria-live="polite">${esc(saveState)}</span></div><div class="assessment-content"><h1>Resume your assessment</h1><p class="assessment-helper">Your unfinished answers are saved. Continue where you left off.</p><button type="button" class="continue-button" data-resume>Resume assessment</button></div></section></main>`);
  }
  function field(key,label,type) {
    const value=esc(draft.profile[key]||''); const invalid=fieldErrors[`profile.${key}`] ? ' aria-invalid="true"' : '';
    const placeholder=key==='position' ? ' placeholder="e.g., Founder, Director, Programme Manager"' : '';
    const control=`<input data-profile="${key}" type="${type}" value="${value}" maxlength="160"${placeholder}${invalid}>`;
    return `<label class="field-label">${esc(label)}${control}${fieldErrors[`profile.${key}`]?`<span class="form-error">${esc(fieldErrors[`profile.${key}`])}</span>`:''}</label>`;
  }
  function profilePrompt(index) {
    return [
      'What is your name?',
      `Hi, ${draft.profile.respondentName?.trim() || 'there'} 👋 What is your NGO’s name?`,
      'What is your work email address?',
      'What is your phone number?',
      `What is your position at ${draft.profile.ngoName?.trim() || 'your NGO'}?`,
    ][index];
  }
  function renderAssessment() {
    const active=activeQuestions(), ids=steps(); if (!ids.includes(draft.currentStepId)) draft.currentStepId='profile_1'; const step=currentStep(), index=ids.indexOf(step), question=questions.find(q=>q.id===step);
    const profileIndex=/^profile_[1-5]$/.test(step) ? Number(step.slice(-1))-1 : -1;
    const progress=Math.round((index/(ids.length-1))*100);
    let content='';
    if (draft.completed) content=`<div class="thank-you-card"><h1>Assessment submitted</h1><p>Reference: <strong>${esc(receipt?.reference||'Ask support for your reference')}</strong></p><p>Submitted: ${esc(receipt?.submittedAt||draft.updatedAt||'')}</p><p>Review state: ${esc((receipt?.reviewStatus||'submitted').replaceAll('_',' '))}</p>${receipt?.reviewerScore!==null&&receipt?.reviewerScore!==undefined?`<p>Reviewer-entered score: ${esc(receipt.reviewerScore)} / 100</p>`:''}<p>A reviewer will review your answers. Your PDF report will appear here when it is ready. Contact support for help with access.</p>${receipt?.reportReady?`<a class="continue-button" href="${rootPath}api/assessments/${assessmentId}/report">Download reviewed PDF report</a>`:''}<button type="button" data-refresh>Refresh review status</button></div>`;
    else if(profileIndex>=0) {const [key,label,type]=profileFields[profileIndex];content=`<p class="eyebrow">About your NGO · Question ${profileIndex+1} of 5</p><h1>${esc(profilePrompt(profileIndex))}</h1><p class="assessment-helper">Work at your own pace. Your answers are saved as you go.</p>${field(key,label,type)}`;}
    else if(question) content=`<p class="eyebrow">${esc(question.group)} · ${esc(question.id)}</p><h1 tabindex="-1" data-heading>${esc(question.prompt)}</h1><p class="assessment-helper">Choose the answer that best fits your NGO. If this does not apply, select Not applicable and briefly explain why.</p>${draft.answers[question.id]==='not_sure'?'<p class="form-error">Please update your previous answer before continuing.</p>':''}<div class="answer-buttons" role="group" aria-label="Answer">${Object.entries(labels).map(([value,label])=>`<button type="button" class="answer-button ${value} ${draft.answers[question.id]===value?'selected':''}" data-answer="${value}" aria-pressed="${draft.answers[question.id]===value}">${label}</button>`).join('')}</div>${draft.answers[question.id]==='not_applicable'?`<textarea class="na-reason-input" data-reason="${question.id}" aria-label="Why does this not apply? Please share here." placeholder="Why does this not apply? Please share here." maxlength="500">${esc(draft.naReasons[question.id]||'')}</textarea>`:''}${fieldErrors[`answers.${question.id}`]?`<p class="form-error">${esc(fieldErrors[`answers.${question.id}`])}</p>`:''}${fieldErrors[`naReasons.${question.id}`]?`<p class="form-error">${esc(fieldErrors[`naReasons.${question.id}`])}</p>`:''}`;
    else content=`<h1>Review your answers</h1><p class="assessment-helper">Check every applicable answer. Use Edit to return directly to a question.</p><div class="review-summary">${active.map(q=>`<div class="answer"><span>${esc(q.id)} · ${esc(q.label)}</span><strong>${esc(labels[draft.answers[q.id]]||(draft.answers[q.id]==='not_sure'?'Needs update':'Missing'))}</strong><button type="button" data-go="${q.id}">Edit</button></div>`).join('')}</div>`;
    replace(`<main class="assessment-page"><section class="assessment-shell"><div class="assessment-topbar">${brand}<span class="save-state" role="status" aria-live="polite">${esc(saveState)}</span></div>${conflict?`<div class="form-error" role="alert">This draft differs from the server. <button type="button" data-keep-local>Keep my answers</button> <button type="button" data-use-server>Use server version</button></div>`:''}${draft.completed?content:`<div class="assessment-progress" role="progressbar" aria-label="Assessment progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div><p class="assessment-stage">${esc(question?.group||'About your NGO')}</p><div class="assessment-content">${content}${error?`<p class="form-error" role="alert">${esc(error)}</p>`:''}<div class="assessment-actions">${index>0?'<button type="button" class="back-button" data-back>Back</button>':''}<button type="button" class="continue-button" data-next ${busy||conflict?'disabled':''}>${step==='review'?'Submit assessment':'Continue'}</button><button type="button" class="back-button" data-clear>Clear draft</button></div></div>`}</section></main>`);
    if(question) document.querySelector('[data-heading]')?.focus();
  }
  function validateStep() {
    const step=currentStep(), profileIndex=/^profile_[1-5]$/.test(step) ? Number(step.slice(-1))-1 : -1;
    if(profileIndex>=0) {const [key,label]=profileFields[profileIndex];if(!draft.profile[key]?.trim()) return `Complete ${label.toLowerCase()}.`;}
    if(step==='profile_3'&&!/^\S+@\S+\.\S+$/.test(draft.profile.email)) return 'Enter a valid email address.';
    if(/^q\d+(?:_[a-z]+)?$/.test(step)) {if(!labels[draft.answers[step]]) return 'Choose an answer.'; if(draft.answers[step]==='not_applicable'&&!draft.naReasons[step]?.trim()) return 'Explain why this does not apply.';}
    return '';
  }
  async function advance() {
    if(busy||conflict) return;
    error=validateStep(); if(error){renderAssessment();return;}
    if(currentStep()==='review') {
      const missing=activeQuestions().find(q=>!labels[draft.answers[q.id]]||(draft.answers[q.id]==='not_applicable'&&!draft.naReasons[q.id]?.trim()));
      if(missing){draft.currentStepId=missing.id;error='Complete this answer before submitting.';renderAssessment();return;}
      const previous=draft; draft={...draft,completed:true}; dirty=true;store();busy=true;renderAssessment();
      try {const result=await save(structuredClone(draft));receipt={reference:result.reference||'',submittedAt:result.submittedAt,reviewStatus:'submitted',reportReady:false};error='';}
      catch {draft=previous;dirty=true;store();} finally {busy=false;renderAssessment();}
      return;
    }
    const sequence=steps(), at=sequence.indexOf(currentStep());draft.currentStepId=sequence[Math.min(at+1,sequence.length-1)];dirty=true;store();busy=true;renderAssessment();
    try {await save(structuredClone(draft));error='';}catch{}finally{busy=false;renderAssessment();}
  }
  async function clearDraft() {
    if(!confirm('Clear all draft answers on this device and the server? This cannot be undone.')) return;
    if(draft.completed) return;
    busy=true;renderAssessment();
    try {
      if(assessmentId){const response=await fetch(`${rootPath}api/assessments/${assessmentId}`,{method:'DELETE',credentials:'same-origin',headers:{'x-csrf-token':csrf}});const result=await readResponse(response);revision=result.revision;}
      const profile=draft.profile;draft={...blank(),profile};dirty=false;error='';saveState='Draft cleared';store();
    }catch(failure){error=failure.message;}finally{busy=false;renderAssessment();}
  }
  async function resolveConflict(keepLocal) {
    try {
      const remote=await loadAssessment(assessmentId);revision=remote.assessment.revision||0;
      if(keepLocal){if(remote.assessment.completed) throw Error('This assessment was already submitted.');conflict=false;dirty=true;store();await save(structuredClone(draft));}
      else {draft={...blank(),...remote.assessment,profile:{...blank().profile,...remote.assessment.profile}};receipt=remote.receipt;conflict=false;dirty=false;saveState='Saved version restored';store();}
      error='';
    }catch(failure){error=failure.message;}renderAssessment();
  }
  async function refreshReceipt(){try{const latest=await loadAssessment(assessmentId);receipt=latest.receipt;draft={...draft,...latest.assessment};renderAssessment();}catch(failure){error=failure.message;renderAssessment();}}
  function renderPrivacy(){replace(`<main class="simple-page"><section class="simple-card">${brand}<p class="eyebrow">Privacy note</p><h1>How this assessment uses information</h1><p>We collect the details you provide for payment verification, access, assessment review and report delivery.</p><div class="simple-copy"><h2>What you may provide</h2><p>Contact details, transaction reference, optional payment proof, assessment answers and optional restricted evidence links.</p><h2>Access and storage</h2><p>Authorised reviewers use this information to review your submission. Evidence access can be arranged later. Redact unnecessary personal and banking details before sharing.</p><h2>Requests</h2><p>Contact support to ask about access, correction or removal. We will review requests against applicable operational obligations. No automatic deletion period is promised here.</p><a class="text-link" href="${support}" target="_blank" rel="noreferrer">Contact support</a></div></section></main>`);}
  function paymentForm() {
    const saved=JSON.parse(localStorage.getItem('ngo-compass-payment-draft')||'null')||{};
    const upi=settings.upiId?`upi://pay?pa=${encodeURIComponent(settings.upiId)}&pn=${encodeURIComponent(settings.payeeName)}&am=1999&cu=INR&tr=${encodeURIComponent(paymentReference)}`:'';
    return `<main class="payment-page"><section class="payment-card"><header class="payment-header">${brand}<span class="payment-secure">Manual UPI verification</span></header><div class="payment-intro"><h1>Complete your payment</h1><p>Pay ₹1,999 using the configured UPI details, then submit your transaction reference. Our team manually verifies it and provides a one-time assessment link. Keep your reference and contact support if access has not arrived.</p></div><div class="payee-panel"><div class="qr-wrap">${settings.qrDataUrl?`<img src="${esc(settings.qrDataUrl)}" alt="Configured payment QR">`:''}</div><div class="payee-details"><p class="payment-label">Pay to</p><h2>${esc(settings.payeeName)}</h2><p>UPI ID: <strong>${esc(settings.upiId)}</strong></p>${upi?`<a class="upi-open" href="${esc(upi)}">Open UPI app ↗</a>`:''}</div></div><form class="payment-form" data-payment-form><p class="payment-reference-confirmation">Reference: <strong>${esc(paymentReference)}</strong></p><div class="payment-fields">${[['respondentName','Your name','text'],['ngoName','Organisation name','text'],['email','Email address','email'],['phoneNumber','Phone number','tel'],['utr','UPI transaction reference / UTR','text']].map(([key,label,type])=>`<label class="field-label">${label}<input name="${key}" type="${type}" value="${esc(saved[key]||'')}" required></label>`).join('')}<label class="field-label">Payment proof (optional)<input name="proof" type="file" accept="application/pdf,image/jpeg,image/png"></label><p class="field-hint">PDF, JPEG or PNG under 5 MB.</p></div><label class="consent-check"><input name="consent" type="checkbox" required ${saved.consent?'checked':''}>I confirm these payment details are accurate.</label><p class="form-error" role="alert">${esc(error)}</p><button class="continue-button payment-submit" type="submit">Submit payment details</button></form></section><p class="payment-support"><a href="${support}" target="_blank" rel="noreferrer">Contact support</a></p></main>`;
  }
  function paymentReceipt(payment) {return `<main class="payment-page"><section class="payment-card confirmation-card">${brand}<div class="confirmation-icon" aria-hidden="true">✓</div><h1>Payment details received</h1><p>Reference: <strong>${esc(payment.reference)}</strong></p><p>Status: <strong>${esc(payment.status)}</strong></p><p>${payment.status==='pending'?'Awaiting manual verification. An admin will provide a one-time assessment link after verification.':payment.status==='verified'?'Verified. Use the access link supplied by our team, or contact support if you need help.':'This submission was not verified. Contact support with your reference.'}</p><button type="button" data-payment-refresh>Refresh status</button><p><a href="${support}" target="_blank" rel="noreferrer">Contact support</a></p></section></main>`;}
  async function initPayment() {
    replace(`<main class="payment-page"><section class="payment-card">Loading payment details…</section></main>`);
    try {await bootstrap();} catch {replace(`<main class="payment-page"><section class="payment-card">Payment service is unavailable. <a href="${support}">Contact support</a>.</section></main>`);return;}
    const savedReference=localStorage.getItem(paymentKey);
    if(savedReference){try{const response=await fetch(`${rootPath}api/payments/status?reference=${encodeURIComponent(savedReference)}`,{credentials:'same-origin'});const payment=await readResponse(response);paymentReference=payment.reference;replace(paymentReceipt(payment));return;}catch{}}
    paymentReference=settings.orderReference||paymentReference;
    if(!settings.available){replace(`<main class="payment-page"><section class="payment-card">${brand}<h1>Payments unavailable</h1><p>UPI payment details are not configured. Please contact support.</p><a href="${support}" target="_blank" rel="noreferrer">Contact support</a></section></main>`);return;}
    replace(paymentForm());
  }
  async function submitPayment(form) {
    if(busy)return;busy=true; const button=document.querySelector('.payment-submit');if(button)button.disabled=true;
    const values=Object.fromEntries(new FormData(form).entries());values.consent=Boolean(form.elements.consent.checked);values.orderReference=paymentReference;
    const file=form.elements.proof.files?.[0];
    try{
      if(file){if(!['application/pdf','image/jpeg','image/png'].includes(file.type)||file.size>5_000_000)throw Error('Use a PDF, JPEG or PNG under 5 MB.');values.proof={name:file.name,type:file.type,size:file.size,data:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('Could not read proof.'));reader.readAsDataURL(file);})};}else values.proof=null;
      const result=await post('payment',values);paymentReference=result.orderReference;localStorage.setItem(paymentKey,paymentReference);localStorage.removeItem('ngo-compass-payment-draft');error='';replace(paymentReceipt({reference:paymentReference,status:'pending'}));
    }catch(failure){error=failure.message;const el=form.querySelector('.form-error');if(el)el.textContent=error;}finally{busy=false;if(button)button.disabled=false;}
  }
  document.addEventListener('click', event => {
    const button=event.target.closest('button');if(!button)return;
    if(button.matches('[data-resume]')){renderAssessment();return;}
    if(button.matches('[data-next]')){void advance();return;}if(button.matches('[data-back]')){const list=steps(),at=list.indexOf(currentStep());draft.currentStepId=list[Math.max(0,at-1)];dirty=true;store();renderAssessment();return;}
    if(button.matches('[data-clear]')){void clearDraft();return;}if(button.matches('[data-go]')){draft.currentStepId=button.dataset.go;dirty=true;store();renderAssessment();return;}
    if(button.matches('[data-answer]')){draft.answers[button.closest('[data-question]')?.dataset.question||currentStep()]=button.dataset.answer;dirty=true;store();renderAssessment();scheduleSave();return;}
    if(button.matches('[data-use-server]')){void resolveConflict(false);return;}if(button.matches('[data-keep-local]')){void resolveConflict(true);return;}
    if(button.matches('[data-refresh]')){void refreshReceipt();return;}if(button.matches('[data-payment-refresh]')){void initPayment();}
  });
  document.addEventListener('input', event => {
    const element=event.target;
    if(element.matches('[data-profile]')){draft.profile[element.dataset.profile]=element.value;dirty=true;store();saveState='Saving…';updateSaveState();scheduleSave();}
    if(element.matches('[data-reason]')){draft.naReasons[element.dataset.reason]=element.value;dirty=true;store();scheduleSave();}
    if(element.closest('[data-payment-form]')){const form=element.closest('form');const data=Object.fromEntries(new FormData(form).entries());delete data.proof;data.consent=form.elements.consent.checked;localStorage.setItem('ngo-compass-payment-draft',JSON.stringify(data));}
  });
  document.addEventListener('change', event => {if(event.target.matches('[data-profile]')){draft.profile[event.target.dataset.profile]=event.target.value;dirty=true;store();scheduleSave();}});
  document.addEventListener('submit', event => {if(event.target.matches('[data-payment-form]')){event.preventDefault();void submitPayment(event.target);}});
  document.addEventListener('keydown', event => {if(!/\/assessment\/?$/.test(location.pathname))return;if(event.target.matches('input,textarea,select'))return;if(['1','2','3'].includes(event.key)&&/^q\d+(?:_[a-z]+)?$/.test(currentStep())){event.preventDefault();const value=['yes','no','not_applicable'][Number(event.key)-1];draft.answers[currentStep()]=value;dirty=true;store();renderAssessment();scheduleSave();}});
  window.addEventListener('storage', event => {if(event.key===assessmentKey&&assessmentId){conflict=true;saveState='Another tab changed this draft.';renderAssessment();}});
  async function start(){const path=location.pathname;if(/\/assessment\/?$/.test(path))await initAssessment();else if(/\/payment\/?$/.test(path))await initPayment();else if(/\/privacy\/?$/.test(path))renderPrivacy();}
  void start();
})();
