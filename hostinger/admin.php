<?php
declare(strict_types=1);
require __DIR__ . '/common.php';

function html(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function adminCredentials(): array {
    $config = storage('admin-config.php');
    $private = is_file($config) ? require $config : [];
    if (!is_array($private)) $private = [];
    return [textValue($private['email'] ?? getenv('ADMIN_EMAIL') ?: '',160), (string) ($private['passwordHash'] ?? getenv('ADMIN_PASSWORD_HASH') ?: ''), (string) (getenv('ADMIN_PASSWORD') ?: '')];
}
function adminSession(): bool {
    $cookie = $_COOKIE['ngo_compass_admin'] ?? null;
    if (!validToken($cookie)) return false;
    $record = readJson(storage('sessions/admin-' . digest($cookie) . '.json'));
    return $record && strtotime((string) ($record['expiresAt'] ?? '')) > time();
}
function requireAdmin(): void { if (!adminSession()) fail('Admin sign-in required.', 403); }
function adminRedirect(): never { header('Location: /FundingReady/admin', true, 303); exit; }
function issueLink(array &$payment): string {
    foreach (['token' => 'access-', 'slug' => 'slug-'] as $kind => $lockPrefix) {
        foreach (glob(storage('access/' . $kind . '-*.json')) ?: [] as $path) {
            $hash = substr(basename($path), strlen($kind) + 1, -5);
            if (!preg_match('/^[a-f0-9]{64}$/D', $hash)) continue;
            locked($lockPrefix . $hash, function () use ($path, $payment) {
                $record = readJson($path);
                if (!$record || ($record['paymentId'] ?? '') !== $payment['id'] || ($record['usedAt'] ?? '') !== '') return;
                $record['revokedAt'] = now();
                if (!writeJson($path, $record)) fail('Unable to revoke the prior access link.', 500);
            });
        }
    }
    $new = token(); $payment['accessHash'] = digest($new);
    if (!writeJson(storage('access/token-' . $payment['accessHash'] . '.json'), ['paymentId'=>$payment['id'],'createdAt'=>now(),'expiresAt'=>gmdate('c',time()+604800),'usedAt'=>'','revokedAt'=>''])) fail('Unable to issue access.', 500);
    return 'https://ngocompass.com/FundingReady/access/' . $new;
}
function allPayments(): array {
    $rows = [];
    foreach (glob(storage('payments/payment-*.json')) ?: [] as $file) {
        $record = readJson($file); if ($record && validId($record['id'] ?? null)) $rows[] = $record;
    }
    usort($rows, static fn ($a,$b) => strcmp((string) ($b['createdAt'] ?? ''), (string) ($a['createdAt'] ?? '')));
    return $rows;
}
function layout(string $body): never {
    header('Content-Type: text/html; charset=utf-8'); header('Cache-Control: no-store');
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Funding Ready admin</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f5f8f7;color:#153834;margin:0}main{max-width:1080px;margin:32px auto;padding:0 18px}header,.card{background:white;border:1px solid #d5e0db;border-radius:16px;padding:24px;margin-bottom:18px;box-shadow:0 8px 24px #1b3c3210}h1{margin:0 0 8px;font-size:2rem}h2{margin:0 0 14px}label{display:block;margin:12px 0;font-weight:600}input,select,textarea{display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:5px;border:1px solid #9fb5ad;border-radius:8px;font:inherit}textarea{min-height:90px}button{background:#157463;color:white;border:0;border-radius:8px;padding:10px 15px;font:inherit;cursor:pointer;margin:6px 8px 6px 0}button.secondary{background:#e7f0eb;color:#143b32}a{color:#0b6656;overflow-wrap:anywhere}.muted{color:#55736a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.row{border-top:1px solid #d5e0db;padding:16px 0}.notice{background:#e9f5ee;padding:14px;border-radius:8px;overflow-wrap:anywhere}.error{color:#9d2032}summary{cursor:pointer;font-weight:700}small{font-weight:400}.inline{display:inline}.inline button{float:right}</style></head><body><main>' . $body . '</main></body></html>'; exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$resource = $_GET['resource'] ?? '';
$resourceId = $_GET['id'] ?? null;
if ($resource !== '') {
    requireAdmin();
    if (!validId($resourceId)) fail('Record not found.', 404);
    $payment = readJson(paymentFile($resourceId));
    if (!$payment) fail('Record not found.', 404);
    if ($resource === 'proof' && $method === 'GET') {
        $proof = $payment['proof'] ?? null; $file = is_array($proof) ? ($proof['file'] ?? '') : '';
        if (is_string($file) && $file !== '') attachment($file, 'payment-proof.' . pathinfo($file, PATHINFO_EXTENSION));
        $legacy = is_array($proof) ? ($proof['data'] ?? '') : '';
        if (!is_string($legacy) || !preg_match('#^data:(application/pdf|image/jpeg|image/png);base64,([A-Za-z0-9+/=]+)$#D', $legacy, $match)) fail('Proof not found.', 404);
        $bytes = base64_decode($match[2], true); $detected = is_string($bytes) ? detectFileType($bytes) : null;
        if ($detected === null || $detected[0] !== $match[1] || strlen($bytes) > 5_000_000) fail('Proof not found.', 404);
        header('Content-Type: ' . $detected[0]); header('Content-Disposition: attachment; filename="payment-proof.' . $detected[1] . '"'); header('Cache-Control: no-store'); echo $bytes; exit;
    }
    if ($resource === 'report' && $method === 'GET') {
        $file = $payment['report']['file'] ?? '';
        if (!is_string($file) || $file === '') fail('Report not found.', 404);
        attachment($file, 'Funding-Ready-report.pdf');
    }
    if ($resource === 'report' && $method === 'POST') {
        requireCsrf();
        if (($_SERVER['CONTENT_TYPE'] ?? '') !== 'application/pdf' || (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 10_000_000) fail('Upload a PDF under 10 MB.');
        $bytes = file_get_contents('php://input');
        $detected = is_string($bytes) ? detectFileType($bytes) : null;
        if (!is_string($bytes) || strlen($bytes) < 8 || strlen($bytes) > 10_000_000 || $detected === null || $detected[0] !== 'application/pdf') fail('Upload a valid PDF under 10 MB.');
        $file = bin2hex(random_bytes(16)) . '.pdf';
        if (file_put_contents(storage('uploads/' . $file), $bytes, LOCK_EX) === false) fail('Unable to store report.', 500);
        @chmod(storage('uploads/' . $file), 0600);
        locked('payment-' . $resourceId, function () use ($resourceId, $file) {
            $path = paymentFile($resourceId); $record = readJson($path);
            if (!$record || !validId($record['assessmentId'] ?? null)) fail('Assessment not found.', 404);
            $assessment = readJson(assessmentFile($record['assessmentId']));
            if (!$assessment || !($assessment['completed'] ?? false)) fail('Assessment is not submitted.', 409);
            $old = $record['report']['file'] ?? '';
            $record['report'] = ['file'=>$file,'type'=>'application/pdf','uploadedAt'=>now()];
            $record['reviewStatus'] = 'report_ready'; $record['reviewHistory'][] = ['status'=>'report_ready','at'=>now(),'by'=>'admin upload']; $record['updatedAt'] = now();
            if (!writeJson($path, $record)) { @unlink(storage('uploads/' . $file)); fail('Unable to save report.', 500); }
            if (is_string($old) && $old !== '' && $old !== $file) @unlink(storage('uploads/' . $old));
        });
        jsonResponse(['ok'=>true]);
    }
    fail('Method not allowed.', 405);
}

$notice = ''; $error = '';
if ($method === 'POST') {
    requireCsrf(textValue($_POST['csrf'] ?? '',128));
    $action = textValue($_POST['action'] ?? '',40);
    if ($action === 'login') {
        [$email,$hash,$plain] = adminCredentials();
        if ($email === '' || ($hash === '' && $plain === '')) fail('Admin login is not configured.', 503);
        $ip = textValue($_SERVER['REMOTE_ADDR'] ?? '',80);
        locked('admin-login-' . $ip, function () use ($ip, $email, $hash, $plain, &$error) {
            $path = storage('rate-admin-' . digest($ip) . '.json'); $rate = readJson($path) ?: ['started'=>time(),'count'=>0];
            if (time() - (int) ($rate['started'] ?? 0) >= 900) $rate = ['started'=>time(),'count'=>0];
            if ((int) ($rate['count'] ?? 0) >= 5) fail('Too many login attempts. Try later.', 429);
            $candidate = (string) ($_POST['password'] ?? '');
            $valid = hash_equals(strtolower($email), strtolower(textValue($_POST['email'] ?? '',160))) && ($hash !== '' ? password_verify($candidate, $hash) : hash_equals($plain, $candidate));
            if (!$valid) { $rate['count']++; writeJson($path, $rate); $error = 'Invalid email or password.'; return; }
            @unlink($path);
            $old = $_COOKIE['ngo_compass_admin'] ?? null;
            if (validToken($old)) @unlink(storage('sessions/admin-' . digest($old) . '.json'));
            $new = token();
            if (!writeJson(storage('sessions/admin-' . digest($new) . '.json'), ['createdAt'=>now(),'expiresAt'=>gmdate('c',time()+28800)])) fail('Unable to sign in.', 500);
            appCookie('ngo_compass_admin', $new, 28800); adminRedirect();
        });
    } else {
        requireAdmin();
        if ($action === 'logout') {
            $cookie = $_COOKIE['ngo_compass_admin'] ?? null;
            if (validToken($cookie)) @unlink(storage('sessions/admin-' . digest($cookie) . '.json'));
            appCookie('ngo_compass_admin', '', -3600); adminRedirect();
        }
        if ($action === 'settings') {
            $payee = textValue($_POST['payeeName'] ?? '',160); $upi = textValue($_POST['upiId'] ?? '',160);
            if (($payee === '') !== ($upi === '')) fail('Set both payee name and UPI ID, or leave both blank.');
            if ($upi !== '' && !preg_match('/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/D', $upi)) fail('Invalid UPI ID.');
            $prior = readJson(storage('payment-settings.json')) ?: [];
            if (!writeJson(storage('payment-settings.json'), ['payeeName'=>$payee,'upiId'=>$upi,'upiPhone'=>textValue($prior['upiPhone'] ?? '',40),'qrDataUrl'=>$prior['qrDataUrl'] ?? ''])) fail('Unable to save settings.', 500);
            $notice = 'Payment settings saved.';
        } elseif ($action === 'create_manual') {
            $ngo = textValue($_POST['ngoName'] ?? '',160); if ($ngo === '') fail('Enter an organisation name.');
            $id = bin2hex(random_bytes(18));
            $record = ['id'=>$id,'manual'=>true,'orderReference'=>'MANUAL-' . strtoupper(bin2hex(random_bytes(5))),'profile'=>['ngoName'=>$ngo,'respondentName'=>'','email'=>'','phoneNumber'=>''],'utr'=>'','proof'=>null,'status'=>'verified','reviewer'=>'','evidenceStatus'=>'not_started','reviewStatus'=>'','reviewerScore'=>null,'internalNotes'=>'','reviewHistory'=>[],'downloadHistory'=>[],'report'=>null,'assessmentId'=>'','createdAt'=>now(),'updatedAt'=>now(),'verifiedAt'=>now()];
            $link = issueLink($record);
            if (!writeJson(paymentFile($id), $record)) fail('Unable to grant access.', 500);
            $notice = 'Complimentary access created. Copy this one-time link now: ' . $link;
        } elseif (in_array($action, ['verify','reject','reissue','review'], true)) {
            $id = $_POST['id'] ?? null; if (!validId($id)) fail('Payment not found.', 404);
            locked('payment-' . $id, function () use ($id,$action,&$notice) {
                $path = paymentFile($id); $record = readJson($path); if (!$record) fail('Payment not found.', 404);
                if ($action === 'verify') {
                    if (($record['status'] ?? '') !== 'pending') fail('Only pending payments can be verified.', 409);
                    $record['status'] = 'verified'; $record['verifiedAt'] = now(); $notice = 'Payment verified. One-time link: ' . issueLink($record);
                } elseif ($action === 'reject') {
                    if (($record['status'] ?? '') !== 'pending') fail('Only pending payments can be rejected.', 409);
                    $record['status'] = 'rejected'; $notice = 'Payment rejected.';
                } elseif ($action === 'reissue') {
                    if (($record['status'] ?? '') !== 'verified') fail('Only verified access can be reissued.', 409);
                    $notice = 'New one-time link: ' . issueLink($record);
                } else {
                    $state = textValue($_POST['reviewStatus'] ?? '',32); $evidence = textValue($_POST['evidenceStatus'] ?? '',32);
                    if (!in_array($state,['submitted','in_review','report_ready','delivered'],true) || !in_array($evidence,['not_started','in_progress','complete'],true)) fail('Invalid review state.');
                    if (!validId($record['assessmentId'] ?? null)) fail('Assessment not submitted.', 409);
                    $assessment = readJson(assessmentFile($record['assessmentId'])); if (!$assessment || !($assessment['completed'] ?? false)) fail('Assessment not submitted.', 409);
                    if ($state === 'report_ready' && empty($record['report']['file'])) fail('Upload the PDF before marking it ready.', 409);
                    if ($state === 'delivered' && empty($record['downloadHistory'])) fail('Delivery has not been recorded.', 409);
                    $score = textValue($_POST['reviewerScore'] ?? '',4);
                    if ($score !== '' && (!ctype_digit($score) || (int) $score > 100)) fail('Score must be 0–100.');
                    $record['reviewer'] = textValue($_POST['reviewer'] ?? '',120); $record['evidenceStatus'] = $evidence; $record['internalNotes'] = textValue($_POST['internalNotes'] ?? '',4000); $record['reviewerScore'] = $score === '' ? null : (int) $score;
                    if (($record['reviewStatus'] ?? '') !== $state) $record['reviewHistory'][] = ['status'=>$state,'at'=>now(),'by'=>'admin'];
                    $record['reviewStatus'] = $state; $notice = 'Review saved.';
                }
                $record['updatedAt'] = now(); if (!writeJson($path, $record)) fail('Unable to save change.', 500);
            });
        }
    }
}

$csrf = csrfToken();
if (!adminSession()) {
    [$email,$hash,$plain] = adminCredentials();
    $configured = $email !== '' && ($hash !== '' || $plain !== '');
    layout('<section class="card"><h1>Funding Ready admin</h1><p class="muted">Review payments, issue access and deliver reports.</p>' . ($configured ? '' : '<p class="error">Admin login is unavailable until credentials are configured.</p>') . ($error ? '<p class="error">' . html($error) . '</p>' : '') . '<form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="action" value="login"><label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" required></label><button>Sign in</button></form></section>');
}
$settings = paymentSettings(); $rows = allPayments();
$body = '<header><form method="post" class="inline"><input type="hidden" name="csrf" value="' . html($csrf) . '"><button class="secondary" name="action" value="logout">Log out</button></form><h1>Funding Ready operations</h1><p class="muted">' . count($rows) . ' access and payment records</p></header>';
if ($notice !== '') $body .= '<p class="notice" role="status">' . html($notice) . '</p>';
$body .= '<section class="card"><h2>Payment setup</h2><form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="action" value="settings"><div class="grid"><label>Payee name<input name="payeeName" value="' . html($settings['payeeName']) . '"></label><label>UPI ID<input name="upiId" value="' . html($settings['upiId']) . '"></label></div><button>Save payment settings</button></form></section>';
$body .= '<section class="card"><h2>Complimentary access</h2><form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="action" value="create_manual"><label>Organisation name<input name="ngoName" required></label><button>Create one-time link</button></form></section>';
$body .= '<section class="card"><h2>Payments and assessments</h2>';
foreach ($rows as $row) {
    $id = $row['id']; $name = html((string) ($row['profile']['ngoName'] ?? 'Unnamed organisation')); $status = html((string) ($row['status'] ?? 'pending'));
    $body .= '<details class="row"><summary>' . $name . ' · ' . $status . ' <small>· ' . html((string) ($row['orderReference'] ?? '')) . '</small></summary><p class="muted">Created ' . html((string) ($row['createdAt'] ?? '')) . ' · UTR ' . html((string) ($row['utr'] ?? '')) . '</p>';
    if (!empty($row['proof']['file'])) $body .= '<p><a href="/FundingReady/admin/proof/' . $id . '">Download payment proof</a></p>';
    if (($row['status'] ?? '') === 'pending') $body .= '<form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="id" value="' . $id . '"><button name="action" value="verify">Verify payment and issue link</button><button class="secondary" name="action" value="reject">Reject</button></form>';
    if (($row['status'] ?? '') === 'verified') $body .= '<form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="id" value="' . $id . '"><button class="secondary" name="action" value="reissue">Reissue one-time link</button></form>';
    if (validId($row['assessmentId'] ?? null)) {
        $body .= '<p>Assessment: ' . html((string) $row['assessmentId']) . ' · Review: ' . html((string) ($row['reviewStatus'] ?? 'not submitted')) . '</p><form method="post"><input type="hidden" name="csrf" value="' . html($csrf) . '"><input type="hidden" name="id" value="' . $id . '"><input type="hidden" name="action" value="review"><div class="grid"><label>Reviewer<input name="reviewer" value="' . html((string) ($row['reviewer'] ?? '')) . '"></label><label>Evidence status<select name="evidenceStatus">';
        foreach (['not_started','in_progress','complete'] as $option) $body .= '<option value="' . $option . '"' . (($row['evidenceStatus'] ?? 'not_started') === $option ? ' selected' : '') . '>' . str_replace('_',' ',$option) . '</option>';
        $body .= '</select></label><label>Review status<select name="reviewStatus">';
        foreach (['submitted','in_review','report_ready','delivered'] as $option) $body .= '<option value="' . $option . '"' . (($row['reviewStatus'] ?? 'submitted') === $option ? ' selected' : '') . '>' . str_replace('_',' ',$option) . '</option>';
        $body .= '</select></label><label>Reviewer score, optional<input type="number" min="0" max="100" name="reviewerScore" value="' . html((string) ($row['reviewerScore'] ?? '')) . '"></label></div><label>Internal notes<textarea name="internalNotes" maxlength="4000">' . html((string) ($row['internalNotes'] ?? '')) . '</textarea></label><button>Save review</button></form><label>Reviewed PDF<input type="file" accept="application/pdf" data-report="' . $id . '"></label><button type="button" data-upload="' . $id . '">Upload PDF</button>';
        if (!empty($row['report']['file'])) $body .= '<a href="/FundingReady/admin/report/' . $id . '">Download current report</a>';
    }
    $body .= '</details>';
}
$body .= '</section><script>document.addEventListener("click",async e=>{const b=e.target.closest("[data-upload]");if(!b)return;const input=document.querySelector(`[data-report="${b.dataset.upload}"]`);const file=input?.files?.[0];if(!file)return alert("Choose a PDF first.");if(file.type!=="application/pdf"||file.size>10000000)return alert("Use a PDF under 10 MB.");b.disabled=true;try{const r=await fetch(`/FundingReady/admin/report/${b.dataset.upload}`,{method:"POST",headers:{"content-type":"application/pdf","x-csrf-token":' . json_encode($csrf) . '},body:file});if(!r.ok)throw Error((await r.json()).error||"Upload failed");location.reload()}catch(error){alert(error.message);b.disabled=false}})</script>';
layout($body);
