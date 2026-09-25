<?php
declare(strict_types=1);

ini_set('session.cookie_httponly', '1');
ini_set('session.cookie_secure', '1');
ini_set('session.cookie_samesite', 'Lax');
session_name('ngo_compass_admin');
session_start();

$adminEmail = 'contact@ngocompass.com';
$adminPasswordHash = '__ADMIN_PASSWORD_HASH__';
$dataDir = dirname(__DIR__, 4) . '/ngo-compass-funding-ready-data';
$paymentsDir = $dataDir . '/payments';
$accessDir = $dataDir . '/access';
$settingsFile = $dataDir . '/payment-settings.json';
$questions = json_decode((string) @file_get_contents(__DIR__ . '/questions.json'), true) ?: [];
$error = '';
$notice = '';
$oneTimeLink = '';

function h(mixed $value): string { return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function cleanText(mixed $value, int $max): string { return is_string($value) ? mb_substr(trim($value), 0, $max) : ''; }
function randomToken(int $bytes = 32): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function hashToken(string $value): string { return hash('sha256', $value); }
function jsonRead(string $path): ?array { if (!is_file($path)) return null; $decoded = json_decode((string) @file_get_contents($path), true); return is_array($decoded) ? $decoded : null; }
function jsonWriteAtomic(string $path, array $record): bool { $temporary = tempnam(dirname($path), '.write-'); if ($temporary === false) return false; $encoded = json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); if ($encoded === false || file_put_contents($temporary, $encoded, LOCK_EX) === false) { @unlink($temporary); return false; } @chmod($temporary, 0600); if (!@rename($temporary, $path)) { @unlink($temporary); return false; } return true; }
function adminCsrf(): string { if (!isset($_SESSION['csrf']) || !is_string($_SESSION['csrf']) || !preg_match('/^[A-Za-z0-9_-]{32,128}$/', $_SESSION['csrf'])) $_SESSION['csrf'] = randomToken(24); return $_SESSION['csrf']; }
function validCsrf(): bool { $value = $_POST['csrf'] ?? ''; return is_string($value) && hash_equals(adminCsrf(), $value); }
function rateAllowed(string $bucket, int $limit, int $window): bool { global $dataDir; if (!is_dir($dataDir)) @mkdir($dataDir, 0700, true); $path = $dataDir . '/rate-' . hash('sha256', $bucket) . '.json'; $now = time(); $record = jsonRead($path) ?: ['started' => $now, 'count' => 0]; if ($now - (int) ($record['started'] ?? 0) >= $window) $record = ['started' => $now, 'count' => 0]; if ((int) ($record['count'] ?? 0) >= $limit) return false; $record['count'] = (int) ($record['count'] ?? 0) + 1; jsonWriteAtomic($path, $record); return true; }
function paymentSettings(string $settingsFile): array { $record = jsonRead($settingsFile) ?: []; return ['payeeName' => cleanText($record['payeeName'] ?? '', 160), 'upiId' => cleanText($record['upiId'] ?? '', 160), 'upiPhone' => cleanText($record['upiPhone'] ?? '', 40), 'qrDataUrl' => cleanText($record['qrDataUrl'] ?? '', 2000000)]; }
function paymentPath(string $paymentsDir, string $id): string { return $paymentsDir . '/payment-' . $id . '.json'; }
function safePaymentId(string $id): bool { return (bool) preg_match('/^[a-f0-9]{24,64}$/', $id); }
function readPayments(string $paymentsDir): array { $records = []; foreach (glob($paymentsDir . '/payment-*.json') ?: [] as $file) { $record = jsonRead($file); if (is_array($record)) $records[] = $record; } usort($records, static fn ($a, $b) => strcmp((string) ($b['updatedAt'] ?? ''), (string) ($a['updatedAt'] ?? ''))); return $records; }
function readAssessments(string $dataDir): array { $files = array_merge(glob($dataDir . '/assessment-*.json') ?: [], glob($dataDir . '/*.json') ?: []); $records = []; $seen = []; foreach ($files as $file) { $record = jsonRead($file); if (!is_array($record) || !is_array($record['profile'] ?? null) || !is_array($record['answers'] ?? null)) continue; $id = (string) ($record['id'] ?? pathinfo($file, PATHINFO_FILENAME)); if (isset($seen[$id])) continue; $seen[$id] = true; $record['id'] = preg_replace('/^assessment-/', '', $id) ?: $id; $records[] = $record; } usort($records, static fn ($a, $b) => strcmp((string) ($b['updatedAt'] ?? ''), (string) ($a['updatedAt'] ?? ''))); return $records; }
function answerLabel(mixed $answer): string { return $answer === 'yes' ? 'Yes' : ($answer === 'no' ? 'No' : ($answer === 'not_sure' ? 'Not sure' : ($answer === 'not_applicable' ? 'Not applicable' : 'Not answered'))); }
function pageHead(string $title): void { echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . h($title) . '</title><script src="./qrcode.js" defer></script><style> :root{--ink:#102018;--muted:#526158;--green:#0b5132;--green2:#126b42;--soft:#eaf3ed;--line:#d7e2da}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 5% 0,#dff2e4,transparent 28%),#f5f8f5;color:var(--ink);font:16px Arial,sans-serif}.wrap{max-width:1180px;margin:0 auto;padding:42px 22px}.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:30px;box-shadow:0 20px 60px rgba(6,44,28,.1)}h1{font-size:clamp(30px,5vw,52px);line-height:1;margin:18px 0 12px;letter-spacing:-.05em}h2{font-size:21px;margin:28px 0 10px}p{line-height:1.55}.muted,.help{color:var(--muted)}.eyebrow{color:var(--green2);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:30px}.header img,.login img{display:block;width:180px;height:auto}.button,button{border:0;border-radius:10px;padding:13px 18px;background:var(--green);color:#fff;font:inherit;font-weight:700;cursor:pointer}.button.secondary,button.secondary{background:#fff;color:var(--green);border:1px solid #b7cfc0}.button.warn{background:#805d08}.login{max-width:480px;margin:8vh auto}.login h1{font-size:40px}label{display:block;margin:16px 0 7px;font-weight:700}input,select,textarea{box-sizing:border-box;width:100%;padding:13px;border:1px solid #b7cfc0;border-radius:10px;font:inherit;color:var(--ink);background:#fff}textarea{resize:vertical}.error{padding:12px 14px;border-radius:10px;color:#8a2824;background:#fff0ed;font-weight:700}.notice{padding:16px;border-radius:12px;color:#14552f;background:#e6f6ea;border:1px solid #b7d9c1}.access-link{margin:20px 0;padding:18px;border-radius:13px;background:#ecf8ef;border:1px solid #b7d9c1}.access-link input{margin:10px 0;font-size:12px}.settings{display:grid;grid-template-columns:.9fr 1.1fr;gap:28px;margin:24px 0 44px;padding:24px;border-radius:18px;background:linear-gradient(145deg,var(--soft),#fff);border:1px solid var(--line)}.toolbar{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:34px 0 16px}.toolbar form{display:flex;gap:8px}.toolbar form input,.toolbar form select{width:auto;min-width:170px}.row{border-top:1px solid #e1ebe4;padding:18px 0}.row summary{cursor:pointer;display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.row summary strong,.row summary span{display:block}.row summary span{margin-top:5px;font-size:13px;color:var(--muted)}.manual-badge{display:inline-block;margin-left:8px;padding:3px 7px;border-radius:999px;color:#805d08;background:#fbefd0;font-size:11px;font-weight:700;vertical-align:middle}.status{padding:5px 9px;border-radius:8px;font-size:12px;font-weight:700;white-space:nowrap}.pending{color:#755507;background:#fbefd0}.verified{color:#056037;background:#dff2e5}.details{padding:18px 0 2px}.meta{color:var(--muted);font-size:13px}.payment-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin:18px 0}.payment-grid>div{padding:13px;border-radius:11px;background:var(--soft)}.payment-grid span,.payment-grid strong{display:block}.payment-grid span{margin-bottom:6px;color:var(--muted);font-size:12px}.payment-grid strong{overflow-wrap:anywhere}.actions{display:flex;align-items:end;flex-wrap:wrap;gap:12px}.actions>div{min-width:180px;flex:1}.actions button{align-self:end}.answer{display:grid;grid-template-columns:1fr auto;gap:20px;padding:10px 0;border-top:1px solid #edf3ef}.answer strong{font-size:13px}.yes{color:#087241}.no{color:#a2322a}.not{color:#75641c}.empty{color:#84928a;font-weight:500}.report-sent{display:inline-flex;gap:8px;align-items:center;margin-top:17px;color:var(--muted);font-size:13px}.report-sent input{width:17px;height:17px;accent-color:var(--green)}.section-title{margin-top:52px;padding-top:30px;border-top:1px solid var(--line)}.qr-preview{max-width:180px;margin-top:10px}.qr-preview img{width:180px;height:180px;object-fit:contain;border:1px solid var(--line);border-radius:8px}@media(max-width:760px){.wrap{padding:20px 12px}.card{padding:22px 18px;border-radius:18px}.header,.toolbar,.toolbar form,.row summary{display:block}.header form,.toolbar form>*{width:100%;margin-top:10px}.settings{grid-template-columns:1fr;padding:18px}.payment-grid{grid-template-columns:1fr 1fr}.answer{display:block}.answer strong{display:block;margin-top:5px}.actions>div{min-width:100%}}</style></head><body>'; }

if (isset($_POST['login'])) {
    if (!validCsrf()) $error = 'Your sign-in form expired. Please refresh and try again.';
    elseif (!rateAllowed('admin-login:' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 8, 900)) $error = 'Too many sign-in attempts. Try again later.';
    else {
        $email = strtolower(cleanText($_POST['email'] ?? '', 160)); $password = is_string($_POST['password'] ?? null) ? $_POST['password'] : '';
        $passwordOk = false;
        if (preg_match('~\A\$2[ayb]\$\d{2}\$[./A-Za-z0-9]{53}\z~', $adminPasswordHash)) {
            $passwordOk = password_verify($password, $adminPasswordHash);
        } elseif (preg_match('~\A[a-f0-9]{64}\z~', $adminPasswordHash)) {
            $passwordOk = hash_equals($adminPasswordHash, hash('sha256', $password));
        }
        if (hash_equals($adminEmail, $email) && $passwordOk) { session_regenerate_id(true); $_SESSION['ngo_admin'] = true; $_SESSION['csrf'] = randomToken(24); header('Location: admin'); exit; }
        $error = 'Incorrect email or password.';
    }
}

if (isset($_POST['logout'])) {
    if (validCsrf()) { $_SESSION = []; session_destroy(); header('Location: admin'); exit; }
    $error = 'Your sign-out form expired. Please refresh and try again.';
}

if (empty($_SESSION['ngo_admin'])) {
    pageHead('NGO Compass Admin');
    echo '<main class="wrap"><section class="card login"><img src="./ngo-compass-logo.png" alt="NGO Compass"><p class="eyebrow">Private workspace</p><h1>Admin sign in</h1><p class="muted">Review payments, issue assessment access and track reports.</p>';
    if ($error) echo '<p class="error">' . h($error) . '</p>';
    echo '<form method="post"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required><p><button name="login" value="1">Sign in</button></p></form></section></main></body></html>';
    exit;
}

if (isset($_POST['save_settings'])) {
    if (!validCsrf()) $error = 'Your settings form expired. Please refresh and try again.';
    else {
        $settings = paymentSettings($settingsFile); $settings['payeeName'] = cleanText($_POST['payeeName'] ?? '', 160); $settings['upiId'] = cleanText($_POST['upiId'] ?? '', 160); $settings['upiPhone'] = cleanText($_POST['upiPhone'] ?? '', 40);
        if (isset($_FILES['qrFile']) && is_array($_FILES['qrFile']) && (int) ($_FILES['qrFile']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
            $file = $_FILES['qrFile']; $type = (new finfo(FILEINFO_MIME_TYPE))->file((string) ($file['tmp_name'] ?? '')) ?: ''; $size = (int) ($file['size'] ?? 0);
            if ((int) ($file['error'] ?? 1) !== UPLOAD_ERR_OK || $size < 1 || $size > 5000000 || !in_array($type, ['image/jpeg', 'image/png', 'image/webp'], true)) $error = 'Upload a JPG, PNG or WEBP QR image under 5 MB.';
            else { $settings['qrDataUrl'] = 'data:' . $type . ';base64,' . base64_encode((string) file_get_contents((string) $file['tmp_name'])); }
        }
        if (!$error && jsonWriteAtomic($settingsFile, ['payeeName' => $settings['payeeName'], 'upiId' => $settings['upiId'], 'upiPhone' => $settings['upiPhone'], 'qrDataUrl' => $settings['qrDataUrl'], 'updatedAt' => gmdate('c')])) $notice = 'Payment settings saved.';
        elseif (!$error) $error = 'Unable to save payment settings.';
    }
}

if (isset($_POST['create_manual'])) {
    if (!validCsrf()) $error = 'Your manual-link form expired. Please refresh and try again.';
    elseif (!rateAllowed('admin-manual:' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 30, 900)) $error = 'Too many manual links created. Try again later.';
    else {
        $ngoName = cleanText($_POST['manualNgoName'] ?? '', 160); $respondentName = cleanText($_POST['manualRespondentName'] ?? '', 120); $email = strtolower(cleanText($_POST['manualEmail'] ?? '', 160)); $phoneNumber = cleanText($_POST['manualPhoneNumber'] ?? '', 40);
        if (mb_strlen($ngoName) < 2) $error = 'Please enter an NGO name.';
        elseif ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL) === false) $error = 'Please enter a valid email address.';
        elseif ($phoneNumber !== '' && preg_match('/^[+()\-\s\d]{7,24}$/', $phoneNumber) !== 1) $error = 'Please enter a valid phone number.';
        else {
            $createdAt = gmdate('c'); $expiresAt = gmdate('c', time() + 2592000); $created = false;
            for ($attempt = 0; $attempt < 5 && !$created; $attempt++) {
                $id = bin2hex(random_bytes(18)); $reference = 'MANUAL-' . gmdate('Ymd') . '-' . strtoupper(bin2hex(random_bytes(5))); $token = randomToken(32); $paymentFile = paymentPath($paymentsDir, $id); $accessFile = $accessDir . '/token-' . hashToken($token) . '.json';
                $record = ['id' => $id, 'orderReference' => $reference, 'profile' => ['respondentName' => $respondentName, 'ngoName' => $ngoName, 'email' => $email, 'phoneNumber' => $phoneNumber], 'utr' => '', 'proof' => ['name' => '', 'type' => '', 'size' => 0, 'data' => ''], 'consent' => false, 'status' => 'verified', 'reviewer' => '', 'reportDueAt' => '', 'reportSentAt' => '', 'assessmentId' => '', 'createdAt' => $createdAt, 'updatedAt' => $createdAt, 'verifiedAt' => $createdAt, 'manual' => true];
                $accessRecord = ['paymentId' => $id, 'tokenHash' => hashToken($token), 'createdAt' => $createdAt, 'expiresAt' => $expiresAt, 'usedAt' => ''];
                if (is_file($paymentFile)) continue;
                if (!jsonWriteAtomic($accessFile, $accessRecord)) { $error = 'Unable to create the access link.'; break; }
                if (!jsonWriteAtomic($paymentFile, $record)) { @unlink($accessFile); $error = 'Unable to create the manual payment record.'; break; }
                $host = preg_replace('/[^A-Za-z0-9.:-]/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'ngocompass.com')); $basePath = rtrim(dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/FundingReady/admin')), '/'); $oneTimeLink = 'https://' . ($host ?: 'ngocompass.com') . $basePath . '/access/' . $token; $notice = 'Manual assessment link created. No payment or UTR was recorded.'; $created = true;
            }
            if (!$created && !$error) $error = 'Unable to create the manual assessment link. Please try again.';
        }
    }
}

if (isset($_POST['verify_payment'])) {
    if (!validCsrf()) $error = 'Your verification form expired. Please refresh and try again.';
    else {
        $id = cleanText($_POST['payment_id'] ?? '', 64); $path = safePaymentId($id) ? paymentPath($paymentsDir, $id) : ''; $record = $path ? jsonRead($path) : null;
        if (!$record) $error = 'Payment record not found.';
        elseif (($record['status'] ?? '') === 'verified') $error = 'This payment has already been verified.';
        else { $token = randomToken(32); $now = gmdate('c'); $expires = gmdate('c', time() + 2592000); $accessRecord = ['paymentId' => $id, 'tokenHash' => hashToken($token), 'createdAt' => $now, 'expiresAt' => $expires, 'usedAt' => '']; if (!jsonWriteAtomic($accessDir . '/token-' . hashToken($token) . '.json', $accessRecord)) $error = 'Unable to create the access link.'; else { $record['status'] = 'verified'; $record['verifiedAt'] = $now; $record['updatedAt'] = $now; if (!jsonWriteAtomic($path, $record)) $error = 'Payment was not updated. Please try again.'; else { $host = preg_replace('/[^A-Za-z0-9.:-]/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'ngocompass.com')); $basePath = rtrim(dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/FundingReady/admin')), '/'); $oneTimeLink = 'https://' . ($host ?: 'ngocompass.com') . $basePath . '/access/' . $token; $notice = 'Payment verified. Copy the one-time link below and send it to the applicant.'; } } }
    }
}

if (isset($_POST['update_payment'])) {
    if (!validCsrf()) $error = 'Your payment form expired. Please refresh and try again.';
    else {
        $id = cleanText($_POST['payment_id'] ?? '', 64); $path = safePaymentId($id) ? paymentPath($paymentsDir, $id) : ''; $record = $path ? jsonRead($path) : null;
        if (!$record) $error = 'Payment record not found.';
        else { $record['reviewer'] = cleanText($_POST['reviewer'] ?? '', 120); $due = cleanText($_POST['reportDueAt'] ?? '', 40); $record['reportDueAt'] = preg_match('/^\d{4}-\d{2}-\d{2}$/', $due) ? $due : ''; $record['reportSentAt'] = ($_POST['report_sent_state'] ?? '') === '1' ? ((string) ($record['reportSentAt'] ?? '') ?: gmdate('c')) : ''; $record['updatedAt'] = gmdate('c'); if (jsonWriteAtomic($path, $record)) $notice = 'Payment record updated.'; else $error = 'Unable to update payment record.'; }
    }
}

$settings = paymentSettings($settingsFile); $records = readPayments($paymentsDir); $assessments = readAssessments($dataDir); $query = strtolower(cleanText($_GET['q'] ?? '', 120)); $filter = cleanText($_GET['status'] ?? 'all', 30); $visible = array_values(array_filter($records, static function (array $record) use ($query, $filter): bool { $profile = $record['profile'] ?? []; $haystack = strtolower(implode(' ', [(string) ($profile['ngoName'] ?? ''), (string) ($profile['respondentName'] ?? ''), (string) ($profile['email'] ?? ''), (string) ($record['utr'] ?? ''), (string) ($record['orderReference'] ?? '')])); $status = (string) ($record['status'] ?? 'pending'); $notSent = (string) ($record['reportSentAt'] ?? '') === ''; return (!$query || str_contains($haystack, $query)) && ($filter === 'all' || $filter === $status || ($filter === 'report_pending' && $notSent)); }));

pageHead('NGO Compass Admin');
echo '<main class="wrap"><section class="card"><header class="header"><div><img src="./ngo-compass-logo.png" alt="NGO Compass"><p class="eyebrow">Private workspace</p><h1>Funding readiness operations</h1><p class="muted">' . count($records) . ' payment submission(s) · ' . count($assessments) . ' assessment response(s)</p></div><form method="post"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><button class="secondary" name="logout" value="1">Log out</button></form></header>';
if ($error) echo '<p class="error">' . h($error) . '</p>'; if ($notice) echo '<p class="notice">' . h($notice) . '</p>'; if ($oneTimeLink) echo '<div class="access-link"><strong>One-time assessment access link — copy it now</strong><input id="access-link" readonly value="' . h($oneTimeLink) . '" onclick="this.select()"><button type="button" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById(\'access-link\').value)">Copy link</button><p class="help">This link is shown once and is exchanged for a secure session when opened.</p></div>';
echo '<section class="settings"><div><p class="eyebrow">Manual access</p><h2>Create assessment link without payment</h2><p class="help">Use for approved complimentary or offline cases. This creates a verified access record without a fake UTR or payment proof.</p></div><form method="post"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><label for="manualNgoName">NGO name</label><input id="manualNgoName" name="manualNgoName" required placeholder="Organisation name"><label for="manualRespondentName">Respondent name <span>(optional)</span></label><input id="manualRespondentName" name="manualRespondentName"><label for="manualEmail">Email <span>(optional)</span></label><input id="manualEmail" name="manualEmail" type="email"><label for="manualPhoneNumber">Phone <span>(optional)</span></label><input id="manualPhoneNumber" name="manualPhoneNumber" type="tel"><p><button name="create_manual" value="1">Create manual assessment link</button></p></form></section>';
echo '<section class="settings"><div><p class="eyebrow">Payment settings</p><h2>UPI details shown to applicants</h2><p class="help">Configure a payee name and at least one UPI ID, phone number or QR image. Until then, the public payment page remains safely unavailable.</p></div><form method="post" enctype="multipart/form-data"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><label for="payeeName">Payee name</label><input id="payeeName" name="payeeName" value="' . h($settings['payeeName']) . '"><label for="upiId">UPI ID</label><input id="upiId" name="upiId" value="' . h($settings['upiId']) . '" placeholder="name@bank"><label for="upiPhone">UPI-linked phone number</label><input id="upiPhone" name="upiPhone" value="' . h($settings['upiPhone']) . '"><label for="qrFile">Upload QR image</label><input id="qrFile" name="qrFile" type="file" accept="image/jpeg,image/png,image/webp"><p class="help">A payment QR can also be generated from the UPI ID below.</p><div class="actions"><button type="button" class="secondary" id="generate-qr">Generate QR from UPI ID</button><button name="save_settings" value="1">Save payment settings</button></div><textarea id="qrDataUrl" name="qrDataUrl" hidden>' . h($settings['qrDataUrl']) . '</textarea><div class="qr-preview" id="qr-preview">' . ($settings['qrDataUrl'] ? '<img src="' . h($settings['qrDataUrl']) . '" alt="Configured payment QR">' : '') . '</div></form></section>';
echo '<div class="toolbar"><div><p class="eyebrow">Payment queue</p><h2>Payment submissions</h2></div><form method="get"><input name="q" value="' . h($_GET['q'] ?? '') . '" placeholder="Search NGO, name or UTR"><select name="status"><option value="all"' . ($filter === 'all' ? ' selected' : '') . '>All statuses</option><option value="pending"' . ($filter === 'pending' ? ' selected' : '') . '>Pending verification</option><option value="verified"' . ($filter === 'verified' ? ' selected' : '') . '>Verified</option><option value="report_pending"' . ($filter === 'report_pending' ? ' selected' : '') . '>Report not sent</option></select><button>Filter</button></form></div>';
if (!$visible) echo '<p class="muted">No matching payment submissions.</p>';
foreach ($visible as $record) { $profile = $record['profile'] ?? []; $id = (string) ($record['id'] ?? ''); $status = (string) ($record['status'] ?? 'pending'); $manual = (($record['manual'] ?? false) === true) || str_starts_with((string) ($record['orderReference'] ?? ''), 'MANUAL-'); $proof = is_array($record['proof'] ?? null) ? $record['proof'] : []; echo '<details class="row"><summary><div><strong>' . h($profile['ngoName'] ?? 'Unnamed NGO') . ($manual ? ' <span class="manual-badge">Manual access</span>' : '') . '</strong><span>' . h($profile['respondentName'] ?? '') . ' · ' . h($profile['email'] ?? '') . ' · Ref ' . h($record['orderReference'] ?? '') . ' · ' . h($manual ? 'No payment recorded' : 'UTR ' . ($record['utr'] ?? '')) . '</span></div><span class="status ' . ($status === 'verified' ? 'verified' : 'pending') . '">' . ($manual ? 'Manual · Verified' : ($status === 'verified' ? 'Verified' : 'Pending')) . '</span></summary><div class="details"><p class="meta">Created ' . h($record['createdAt'] ?? '') . ' · Updated ' . h($record['updatedAt'] ?? '') . '</p><div class="payment-grid"><div><span>Mobile</span><strong>' . h($profile['phoneNumber'] ?? '') . '</strong></div><div><span>' . ($manual ? 'Payment' : 'Proof') . '</span>' . ($manual ? '<strong>Manual access — no payment recorded</strong>' : (($proof['data'] ?? '') !== '' ? '<a href="' . h($proof['data']) . '" target="_blank">View ' . h($proof['name'] ?? 'proof') . '</a>' : '<strong>Not provided</strong>')) . '</div><div><span>Verified at</span><strong>' . h($record['verifiedAt'] ?? '—') . '</strong></div><div><span>Payment ID</span><strong>' . h($id) . '</strong></div></div>';
if ($status !== 'verified') echo '<form method="post"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><input type="hidden" name="payment_id" value="' . h($id) . '"><button name="verify_payment" value="1">Verify payment and create access link</button></form>';
echo '<form method="post" class="actions" style="margin-top:18px"><input type="hidden" name="csrf" value="' . h(adminCsrf()) . '"><input type="hidden" name="payment_id" value="' . h($id) . '"><input type="hidden" name="report_sent_state" value="' . (($record['reportSentAt'] ?? '') !== '' ? '1' : '0') . '"><div><label>Reviewer</label><input name="reviewer" value="' . h($record['reviewer'] ?? '') . '" placeholder="Assign reviewer"></div><div><label>Report due</label><input type="date" name="reportDueAt" value="' . h(substr((string) ($record['reportDueAt'] ?? ''), 0, 10)) . '"></div><label class="report-sent"><input type="checkbox" name="report_sent_state" value="1"' . (($record['reportSentAt'] ?? '') !== '' ? ' checked' : '') . '> Report sent</label><button name="update_payment" value="1">Save status</button></form></div></details>'; }

echo '<section class="section-title"><p class="eyebrow">Assessment responses</p><h2>' . count($assessments) . ' saved assessment' . (count($assessments) === 1 ? '' : 's') . '</h2></section>';
if (!$assessments) echo '<p class="muted">No assessment responses yet.</p>';
foreach ($assessments as $record) { $profile = $record['profile'] ?? []; $answers = is_array($record['answers'] ?? null) ? $record['answers'] : []; $complete = ($record['completed'] ?? false) === true; echo '<details class="row"><summary><div><strong>' . h($profile['ngoName'] ?? 'Unnamed NGO') . '</strong><span>' . h($profile['respondentName'] ?? '') . ' · ' . h($profile['position'] ?? '') . ' · ' . h($profile['email'] ?? '') . '</span></div><span class="status ' . ($complete ? 'verified' : 'pending') . '">' . ($complete ? 'Complete' : 'In progress') . '</span></summary><div class="details"><p class="meta">Last saved ' . h($record['updatedAt'] ?? '') . ' · ' . count($answers) . '/89 compliance checks answered</p>';
foreach ($questions as $group) { echo '<h2>' . h($group['title'] ?? '') . '</h2>'; foreach (($group['questions'] ?? []) as $question) { $answer = $answers[$question['id']] ?? ''; $class = $answer === 'yes' ? 'yes' : ($answer === 'no' ? 'no' : ($answer ? 'not' : 'empty')); echo '<div class="answer"><span>' . h($question['label'] ?? '') . '</span><strong class="' . $class . '">' . h(answerLabel($answer)) . '</strong></div>'; } }
echo '</div></details>'; }
echo '</section></main><script>document.getElementById("generate-qr")?.addEventListener("click",()=>{const id=document.getElementById("upiId").value.trim(),pn=document.getElementById("payeeName").value.trim(),out=document.getElementById("qr-preview"),field=document.getElementById("qrDataUrl");if(!id||!window.QRCode?.toDataURL){out.textContent="Enter a UPI ID and ensure QR generation is available, or upload an image.";return}QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(id)}&pn=${encodeURIComponent(pn)}&am=1999&cu=INR`,{width:180,margin:2,color:{dark:"#063d25",light:"#ffffff"}}).then(src=>{field.value=src;out.innerHTML=`<img src="${src}" alt="Generated payment QR">`})});</script></body></html>';
