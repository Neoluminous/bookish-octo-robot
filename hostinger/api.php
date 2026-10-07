<?php
declare(strict_types=1);
require __DIR__ . '/common.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = textValue($_GET['action'] ?? '', 40);

if ($method === 'GET' && $action === 'bootstrap') {
    $reference = 'NGR-' . gmdate('Ymd') . '-' . strtoupper(bin2hex(random_bytes(5)));
    if (!writeJson(orderFile($reference), ['reference'=>$reference,'createdAt'=>now(),'expiresAt'=>gmdate('c', time()+86400),'paymentId'=>''])) fail('Unable to create a payment reference.', 500);
    $accessId = accessPaymentId(); $csrf = csrfToken();
    jsonResponse(['ok'=>true,'status'=>'ok','settings'=>paymentSettings() + ['orderReference'=>$reference], 'csrfToken'=>$csrf,'csrf'=>$csrf,'access'=>$accessId !== '','hasAccess'=>$accessId !== '','paymentId'=>$accessId,'orderReference'=>$reference,'reviewerEmail'=>reviewerEmail()]);
}
if ($method === 'GET' && $action === 'access') {
    $id = accessPaymentId();
    if ($id === '') fail('Assessment access is not active.', 403);
    $csrf = csrfToken(); jsonResponse(['ok'=>true,'access'=>true,'paymentId'=>$id,'csrfToken'=>$csrf,'csrf'=>$csrf]);
}
if ($method === 'GET' && $action === 'exchange') {
    $provided = $_GET['token'] ?? null;
    if (!validToken($provided)) { header('Location: /FundingReady/payment/?access=invalid', true, 303); exit; }
    $result = locked('access-' . digest($provided), function () use ($provided) {
        $path = storage('access/token-' . digest($provided) . '.json');
        $record = readJson($path);
        if (!$record || ($record['usedAt'] ?? '') !== '' || ($record['revokedAt'] ?? '') !== '' || strtotime((string) ($record['expiresAt'] ?? '')) <= time()) return null;
        $paymentId = $record['paymentId'] ?? '';
        $payment = validId($paymentId) ? readJson(paymentFile($paymentId)) : null;
        if (!$payment || ($payment['status'] ?? '') !== 'verified') return null;
        $sessionToken = token();
        $sessionPath = storage('sessions/session-' . digest($sessionToken) . '.json');
        if (!writeJson($sessionPath, ['paymentId'=>$paymentId,'createdAt'=>now(),'expiresAt'=>gmdate('c', time()+2592000)])) fail('Unable to activate assessment access.', 500);
        $record['usedAt'] = now();
        if (!writeJson($path, $record)) { @unlink($sessionPath); fail('Unable to activate assessment access.', 500); }
        return $sessionToken;
    });
    if ($result === null) { header('Location: /FundingReady/payment/?access=invalid', true, 303); exit; }
    appCookie('ngo_compass_access', $result, 2592000); header('Location: /FundingReady/assessment/', true, 303); exit;
}
if ($method === 'GET' && $action === 'exchange-slug') {
    $slug = $_GET['slug'] ?? null;
    if (!is_string($slug) || !preg_match('/^[a-z0-9][a-z0-9-]{2,63}$/D', $slug)) { header('Location: /FundingReady/payment/?access=invalid', true, 303); exit; }
    $hash = digest($slug);
    $session = locked('slug-' . $hash, function () use ($hash) {
        $path = storage('access/slug-' . $hash . '.json'); $record = readJson($path);
        if (!$record || ($record['usedAt'] ?? '') !== '' || ($record['revokedAt'] ?? '') !== '' || strtotime((string) ($record['expiresAt'] ?? '')) <= time()) return null;
        $paymentId = $record['paymentId'] ?? '';
        $payment = validId($paymentId) ? readJson(paymentFile($paymentId)) : null;
        if (!$payment || ($payment['status'] ?? '') !== 'verified') return null;
        $new = token(); $sessionPath = storage('sessions/session-' . digest($new) . '.json');
        if (!writeJson($sessionPath, ['paymentId'=>$paymentId,'createdAt'=>now(),'expiresAt'=>gmdate('c',time()+2592000)])) fail('Unable to activate assessment access.', 500);
        $record['usedAt'] = now();
        if (!writeJson($path, $record)) { @unlink($sessionPath); fail('Unable to activate assessment access.', 500); }
        return $new;
    });
    if ($session === null) { header('Location: /FundingReady/payment/?access=invalid', true, 303); exit; }
    appCookie('ngo_compass_access', $session, 2592000); header('Location: /FundingReady/assessment/', true, 303); exit;
}
if ($method === 'GET' && $action === 'payment-status') {
    $reference = $_GET['reference'] ?? '';
    if (!is_string($reference) || !preg_match('/^NGR-\d{8}-[A-F0-9]{10}$/D', $reference)) fail('Payment not found.', 404);
    $order = readJson(orderFile($reference));
    $paymentId = $order['paymentId'] ?? '';
    $payment = validId($paymentId) ? readJson(paymentFile($paymentId)) : null;
    if (!$payment) fail('Payment not found.', 404);
    jsonResponse(['reference'=>$reference,'status'=>$payment['status'] ?? 'pending']);
}
if ($method === 'GET' && $action === 'load') {
    $id = $_GET['id'] ?? null;
    if (!validId($id)) fail('Assessment not found.', 404);
    $record = readJson(assessmentFile($id));
    if (!$record || !hash_equals((string) ($record['paymentId'] ?? ''), requireAccess())) fail('Assessment not found.', 404);
    $payment = readJson(paymentFile($record['paymentId']));
    jsonResponse(['assessment'=>publicAssessment($record),'receipt'=>receipt($record, $payment)]);
}
if ($method === 'GET' && $action === 'report') {
    $id = $_GET['id'] ?? null;
    if (!validId($id)) fail('Report not found.', 404);
    $assessment = readJson(assessmentFile($id));
    if (!$assessment || !hash_equals((string) ($assessment['paymentId'] ?? ''), requireAccess()) || !($assessment['completed'] ?? false)) fail('Report not found.', 404);
    $payment = readJson(paymentFile($assessment['paymentId']));
    $file = $payment['report']['file'] ?? '';
    if (!is_string($file) || $file === '') fail('Report not found.', 404);
    locked('payment-' . $assessment['paymentId'], function () use ($assessment) {
        $path = paymentFile($assessment['paymentId']); $payment = readJson($path);
        if (!$payment || empty($payment['report']['file'])) return;
        $payment['downloadHistory'][] = ['at'=>now(),'by'=>'applicant'];
        $payment['reviewStatus'] = 'delivered'; $payment['reviewHistory'][] = ['status'=>'delivered','at'=>now(),'by'=>'applicant download'];
        if (!writeJson($path, $payment)) fail('Unable to record report delivery.', 500);
    });
    attachment($file, 'Funding-Ready-report.pdf');
}
if ($method === 'DELETE' && $action === 'reset') {
    requireCsrf(); $id = $_GET['id'] ?? null;
    if (!validId($id)) fail('Assessment not found.', 404);
    locked('assessment-' . $id, function () use ($id) {
        $path = assessmentFile($id); $record = readJson($path);
        if (!$record || !hash_equals((string) ($record['paymentId'] ?? ''), requireAccess())) fail('Assessment not found.', 404);
        if ($record['completed'] ?? false) fail('Submitted assessments cannot be cleared.', 409);
        $record['answers'] = []; $record['naReasons'] = []; $record['currentStepId'] = 'profile';
        $record['revision'] = (int) ($record['revision'] ?? 0) + 1; $record['updatedAt'] = now();
        if (!writeJson($path, $record)) fail('Unable to clear the draft.', 500);
        jsonResponse(['ok'=>true,'revision'=>$record['revision']]);
    });
}
if ($method !== 'POST') fail('Method not allowed.', 405);
requireCsrf(); $body = requestJson(); $action = textValue($body['action'] ?? '', 40);

if ($action === 'payment') {
    if (!paymentSettings()['available']) fail('Payments are not configured. Please contact support.', 503);
    $profile = ['respondentName'=>textValue($body['respondentName'] ?? '',120),'ngoName'=>textValue($body['ngoName'] ?? '',160),'email'=>strtolower(textValue($body['email'] ?? '',160)),'phoneNumber'=>textValue($body['phoneNumber'] ?? '',40)];
    $utr = textValue($body['utr'] ?? '',64); $reference = textValue($body['orderReference'] ?? '',64);
    if (mb_strlen($profile['respondentName']) < 2 || mb_strlen($profile['ngoName']) < 2 || filter_var($profile['email'], FILTER_VALIDATE_EMAIL) === false || !preg_match('/^[+()\-\s\d]{7,24}$/D', $profile['phoneNumber']) || !preg_match('#^[A-Za-z0-9][A-Za-z0-9 ./_-]{5,63}$#D', $utr) || ($body['consent'] ?? false) !== true || !preg_match('/^NGR-\d{8}-[A-F0-9]{10}$/D', $reference)) fail('Please complete all required fields with valid details.');
    $proof = $body['proof'] ?? null; $proofBytes = null; $proofType = null;
    if ($proof !== null) {
        if (!is_array($proof) || !is_string($proof['data'] ?? null) || !is_string($proof['type'] ?? null) || !is_int($proof['size'] ?? null) || $proof['size'] < 1 || $proof['size'] > 5_000_000) fail('Proof must be a PDF, JPEG, or PNG under 5 MB.');
        if (!preg_match('#^data:([a-z]+/[a-z]+);base64,([A-Za-z0-9+/=]+)$#D', $proof['data'], $matches)) fail('Invalid proof file.');
        $proofBytes = base64_decode($matches[2], true); $proofType = is_string($proofBytes) ? detectFileType($proofBytes) : null;
        if ($proofType === null || $proofType[0] !== $matches[1] || $proofType[0] !== $proof['type'] || strlen($proofBytes) !== $proof['size']) fail('Proof must be a PDF, JPEG, or PNG under 5 MB.');
    }
    $ip = textValue($_SERVER['REMOTE_ADDR'] ?? '',80);
    locked('payment-rate-' . $ip, function () use ($ip) {
        $path = storage('rate-' . digest($ip) . '.json'); $rate = readJson($path) ?: ['started'=>time(),'count'=>0];
        if (time() - (int) ($rate['started'] ?? 0) > 900) $rate = ['started'=>time(),'count'=>0];
        if ((int) ($rate['count'] ?? 0) >= 5) fail('Too many attempts. Please try later.', 429);
        $rate['count']++; writeJson($path, $rate);
    });
    locked('order-' . $reference, function () use ($reference, $utr, $profile, $proofBytes, $proofType) {
        $order = readJson(orderFile($reference));
        if (!$order || strtotime((string) ($order['expiresAt'] ?? '')) <= time()) fail('Payment reference expired. Refresh and try again.', 409);
        if (!empty($order['paymentId'])) {
            $existing = readJson(paymentFile($order['paymentId']));
            if ($existing) jsonResponse(['ok'=>true,'paymentId'=>$order['paymentId'],'orderReference'=>$reference]);
        }
        foreach (glob(storage('payments/payment-*.json')) ?: [] as $path) {
            $existing = readJson($path);
            if ($existing && strcasecmp((string) ($existing['utr'] ?? ''), $utr) === 0) fail('This transaction reference has already been submitted.', 409);
        }
        $id = bin2hex(random_bytes(18)); $file = '';
        if ($proofBytes !== null) {
            $file = bin2hex(random_bytes(16)) . '.' . $proofType[1];
            if (file_put_contents(storage('uploads/' . $file), $proofBytes, LOCK_EX) === false) fail('Unable to store payment proof.', 500);
            @chmod(storage('uploads/' . $file), 0600);
        }
        $payment = ['id'=>$id,'orderReference'=>$reference,'profile'=>$profile,'utr'=>$utr,'proof'=>$file === '' ? null : ['file'=>$file,'type'=>$proofType[0],'size'=>strlen($proofBytes)],'consent'=>true,'status'=>'pending','reviewer'=>'','evidenceStatus'=>'not_started','reviewStatus'=>'','reviewerScore'=>null,'internalNotes'=>'','reviewHistory'=>[],'downloadHistory'=>[],'report'=>null,'assessmentId'=>'','createdAt'=>now(),'updatedAt'=>now(),'verifiedAt'=>''];
        if (!writeJson(paymentFile($id), $payment)) { if ($file) @unlink(storage('uploads/' . $file)); fail('Unable to record payment.', 500); }
        $order['paymentId'] = $id;
        if (!writeJson(orderFile($reference), $order)) { @unlink(paymentFile($id)); if ($file) @unlink(storage('uploads/' . $file)); fail('Unable to record payment.', 500); }
        jsonResponse(['ok'=>true,'paymentId'=>$id,'orderReference'=>$reference], 201);
    });
}
if ($action === 'start') {
    $paymentId = requireAccess();
    locked('payment-' . $paymentId, function () use ($paymentId, $body) {
        $payment = readJson(paymentFile($paymentId));
        if (!$payment || ($payment['status'] ?? '') !== 'verified') fail('Verified access is required.', 403);
        $existing = $payment['assessmentId'] ?? '';
        if (validId($existing) && ($record = readJson(assessmentFile($existing)))) jsonResponse(['id'=>$existing,'revision'=>(int) ($record['revision'] ?? 0)]);
        $id = bin2hex(random_bytes(16)); $profile = $payment['profile'] ?? [];
        foreach (is_array($body['profile'] ?? null) ? $body['profile'] : [] as $key => $value) if (is_string($key) && is_string($value)) $profile[$key] = textValue($value, 160);
        $record = ['id'=>$id,'paymentId'=>$paymentId,'profile'=>$profile,'answers'=>[],'naReasons'=>[],'currentStepId'=>'profile_1','completed'=>false,'createdAt'=>now(),'updatedAt'=>now(),'revision'=>0,'schemaVersion'=>3];
        if (!writeJson(assessmentFile($id), $record)) fail('Unable to start assessment.', 500);
        $payment['assessmentId'] = $id; $payment['updatedAt'] = now();
        if (!writeJson(paymentFile($paymentId), $payment)) { @unlink(assessmentFile($id)); fail('Unable to start assessment.', 500); }
        jsonResponse(['id'=>$id,'revision'=>0]);
    });
}
if ($action === 'save') {
    $id = $body['id'] ?? null;
    if (!validId($id)) fail('Invalid assessment data.');
    locked('assessment-' . $id, function () use ($id, $body) {
        $path = assessmentFile($id); $record = readJson($path);
        if (!$record || !hash_equals((string) ($record['paymentId'] ?? ''), requireAccess())) fail('Invalid assessment data.', 403);
        if ($record['completed'] ?? false) fail('Submitted assessments cannot be edited.', 409);
        $revision = $body['revision'] ?? null;
        if (!is_int($revision) || $revision !== (int) ($record['revision'] ?? 0)) fail('This draft changed in another tab.', 409, ['revision'=>(int) ($record['revision'] ?? 0)]);
        $input = $body['draft'] ?? null; [$validated, $errors] = validateDraft($input, is_array($input) && ($input['completed'] ?? false) === true);
        if ($errors) fail('Please correct the highlighted fields.', 422, ['fields'=>$errors]);
        $record['profile'] = $validated['profile']; $record['answers'] = $validated['answers']; $record['naReasons'] = $validated['naReasons'];
        $record['currentStepId'] = textValue($input['currentStepId'] ?? 'profile_1', 40); $record['completed'] = ($input['completed'] ?? false) === true;
        $record['revision']++; $record['updatedAt'] = now(); $record['schemaVersion'] = 3;
        if (!writeJson($path, $record)) fail('Unable to save progress.', 500);
        $payment = readJson(paymentFile($record['paymentId']));
        if ($payment && $record['completed']) locked('payment-' . $record['paymentId'], function () use ($record) {
            $paymentPath = paymentFile($record['paymentId']); $payment = readJson($paymentPath);
            if (!$payment) fail('Payment record is unavailable.', 500);
            $payment['submittedAt'] = $payment['submittedAt'] ?? now(); $payment['reviewStatus'] = 'submitted';
            $payment['reviewHistory'][] = ['status'=>'submitted','at'=>$payment['submittedAt'],'by'=>'applicant']; $payment['updatedAt'] = now();
            if (!writeJson($paymentPath, $payment)) fail('Unable to record submission.', 500);
        });
        $payment = readJson(paymentFile($record['paymentId']));
        jsonResponse(['ok'=>true,'revision'=>$record['revision'],'submittedAt'=>$record['completed'] ? $record['updatedAt'] : '', 'reference'=>$payment['orderReference'] ?? '']);
    });
}
fail('Invalid action.');
