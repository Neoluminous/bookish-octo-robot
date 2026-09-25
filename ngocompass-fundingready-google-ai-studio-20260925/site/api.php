<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$dataDir = dirname(__DIR__, 4) . '/ngo-compass-funding-ready-data';
$paymentsDir = $dataDir . '/payments';
$accessDir = $dataDir . '/access';
$sessionsDir = $dataDir . '/sessions';
$ordersDir = $dataDir . '/orders';
$settingsFile = $dataDir . '/payment-settings.json';
$configuredBasePath = "/FundingReady/";

function respond(array $payload, int $status = 200): never { http_response_code($status); echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }
foreach ([$dataDir, $paymentsDir, $accessDir, $sessionsDir, $ordersDir] as $directory) if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) respond(['error' => 'Unable to prepare secure storage.'], 500);

function cleanText(mixed $value, int $max): string { return is_string($value) ? mb_substr(trim($value), 0, $max) : ''; }
function randomToken(int $bytes = 32): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function hashToken(string $value): string { return hash('sha256', $value); }
function jsonRead(string $path): ?array { if (!is_file($path)) return null; $decoded = json_decode((string) @file_get_contents($path), true); return is_array($decoded) ? $decoded : null; }
function jsonWriteAtomic(string $path, array $record): bool { $temporary = tempnam(dirname($path), '.write-'); if ($temporary === false) return false; $encoded = json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); if ($encoded === false || file_put_contents($temporary, $encoded, LOCK_EX) === false) { @unlink($temporary); return false; } @chmod($temporary, 0600); if (!@rename($temporary, $path)) { @unlink($temporary); return false; } return true; }
function validOpaqueToken(string $value): bool { return (bool) preg_match('/^[A-Za-z0-9_-]{32,128}$/', $value); }
function validHexToken(string $value): bool { return (bool) preg_match('/^[a-f0-9]{32,128}$/', $value); }
function appBasePath(): string {
    global $configuredBasePath;
    if ($configuredBasePath !== '__STATIC_BASE_PATH__') {
        $path = parse_url($configuredBasePath, PHP_URL_PATH);
        $path = is_string($path) ? $path : '/';
    } else {
        $script = parse_url((string) ($_SERVER['SCRIPT_NAME'] ?? ''), PHP_URL_PATH);
        $script = is_string($script) ? $script : '';
        $path = preg_replace('#/api(?:\.php)?$#', '', $script) ?: '';
    }
    $path = trim($path, '/');
    return $path === '' ? '/' : '/' . $path . '/';
}
function redirectToApp(string $path): never { header('Location: ' . rtrim(appBasePath(), '/') . '/' . ltrim($path, '/'), true, 303); exit; }
function cookieValue(string $name): string { return is_string($_COOKIE[$name] ?? null) ? $_COOKIE[$name] : ''; }
function csrfToken(): string { $token = cookieValue('ngo_compass_csrf'); if (validOpaqueToken($token)) return $token; $token = randomToken(24); setcookie('ngo_compass_csrf', $token, ['expires' => time() + 7200, 'path' => '/', 'secure' => true, 'httponly' => false, 'samesite' => 'Lax']); return $token; }
function requireCsrf(): void { $header = is_string($_SERVER['HTTP_X_CSRF_TOKEN'] ?? null) ? $_SERVER['HTTP_X_CSRF_TOKEN'] : ''; $cookie = cookieValue('ngo_compass_csrf'); if (!validOpaqueToken($header) || !validOpaqueToken($cookie) || !hash_equals($cookie, $header)) respond(['error' => 'Your session expired. Refresh the page and try again.'], 403); }
function requestBody(): array { if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 7000000) respond(['error' => 'Your payment proof is too large. Please upload a file under 5 MB.'], 413); $raw = (string) file_get_contents('php://input'); if (strlen($raw) > 7000000) respond(['error' => 'Your payment proof is too large. Please upload a file under 5 MB.'], 413); $payload = json_decode($raw, true); if (!is_array($payload)) respond(['error' => 'Invalid request.'], 400); return $payload; }
function rateAllowed(string $dataDir, string $bucket, int $limit, int $window): bool { $path = $dataDir . '/rate-' . hashToken($bucket) . '.json'; $now = time(); $record = jsonRead($path) ?: ['started' => $now, 'count' => 0]; if ($now - (int) ($record['started'] ?? 0) >= $window) $record = ['started' => $now, 'count' => 0]; if ((int) ($record['count'] ?? 0) >= $limit) return false; $record['count'] = (int) ($record['count'] ?? 0) + 1; return jsonWriteAtomic($path, $record); }
function assessmentPath(string $dir, string $id): string { return $dir . '/assessment-' . $id . '.json'; }
function paymentPath(string $dir, string $id): string { return $dir . '/payment-' . $id . '.json'; }
function orderPath(string $dir, string $reference): string { return $dir . '/order-' . $reference . '.json'; }
function sessionPaymentId(string $sessionsDir): string { $token = cookieValue('ngo_compass_access'); if (!validOpaqueToken($token)) return ''; $record = jsonRead($sessionsDir . '/session-' . hashToken($token) . '.json'); return $record && strtotime((string) ($record['expiresAt'] ?? '')) > time() ? cleanText($record['paymentId'] ?? '', 64) : ''; }
function requireAccess(string $sessionsDir): string { $paymentId = sessionPaymentId($sessionsDir); if (!$paymentId) respond(['error' => 'Assessment access is not active.'], 403); return $paymentId; }
function paymentSettings(string $path): array { $record = jsonRead($path) ?: []; $payeeName = cleanText($record['payeeName'] ?? 'Kuldeep Sagar', 160) ?: 'Kuldeep Sagar'; $upiId = cleanText($record['upiId'] ?? 'kuldeep.sgr27@okhdfcbank', 160) ?: 'kuldeep.sgr27@okhdfcbank'; $upiPhone = cleanText($record['upiPhone'] ?? '', 40); $qrDataUrl = cleanText($record['qrDataUrl'] ?? '', 2000000); return ['payeeName' => $payeeName, 'upiId' => $upiId, 'upiPhone' => $upiPhone, 'qrDataUrl' => $qrDataUrl, 'upiUri' => 'upi://pay?pa=' . rawurlencode($upiId) . '&pn=' . rawurlencode($payeeName) . '&am=1999&cu=INR', 'available' => $payeeName !== '' && ($upiId !== '' || $qrDataUrl !== '')]; }
function validProfile(array $p): bool { return mb_strlen(cleanText($p['respondentName'] ?? '', 120)) >= 2 && mb_strlen(cleanText($p['ngoName'] ?? '', 160)) >= 2 && filter_var(cleanText($p['email'] ?? '', 160), FILTER_VALIDATE_EMAIL) !== false && preg_match('/^[+()\-\s\d]{7,24}$/', cleanText($p['phoneNumber'] ?? '', 40)) === 1; }
function validProof(mixed $proof): bool { if ($proof === null) return true; if (!is_array($proof)) return false; $type = cleanText($proof['type'] ?? '', 80); $size = (int) ($proof['size'] ?? 0); $data = is_string($proof['data'] ?? null) ? $proof['data'] : ''; if (!in_array($type, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], true) || $size < 1 || $size > 5000000 || !preg_match('#^data:' . preg_quote($type, '#') . ';base64,([A-Za-z0-9+/=]+)$#', $data, $match)) return false; $binary = base64_decode($match[1], true); return is_string($binary) && strlen($binary) === $size; }

$method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');
$action = cleanText($_GET['action'] ?? '', 40);

if ($method === 'GET' && $action === 'bootstrap') {
    $reference = 'NGR-' . gmdate('Ymd') . '-' . strtoupper(substr(preg_replace('/[^A-Za-z0-9]/', '', randomToken(8)), 0, 10));
    if (!jsonWriteAtomic(orderPath($ordersDir, $reference), ['reference' => $reference, 'createdAt' => gmdate('c'), 'expiresAt' => gmdate('c', time() + 86400), 'paymentId' => ''])) respond(['error' => 'Unable to create a payment reference.'], 500);
    $settings = paymentSettings($settingsFile); $settings['orderReference'] = $reference; respond(['settings' => $settings, 'csrfToken' => csrfToken(), 'orderReference' => $reference]);
}
if ($method === 'GET' && $action === 'access') { $ok = sessionPaymentId($sessionsDir) !== ''; respond($ok ? ['ok' => true] : ['error' => 'Assessment access is not active.'], $ok ? 200 : 403); }
if ($method === 'GET' && $action === 'exchange') {
    $token = cleanText($_GET['token'] ?? '', 128); $path = $accessDir . '/token-' . hashToken($token) . '.json'; $record = validOpaqueToken($token) ? jsonRead($path) : null;
    if (!$record || ($record['usedAt'] ?? '') !== '' || strtotime((string) ($record['expiresAt'] ?? '')) <= time()) redirectToApp('payment/?access=invalid');
    $record['usedAt'] = gmdate('c'); if (!jsonWriteAtomic($path, $record)) respond(['error' => 'Unable to activate assessment access.'], 500);
    $session = randomToken(32); if (!jsonWriteAtomic($sessionsDir . '/session-' . hashToken($session) . '.json', ['paymentId' => cleanText($record['paymentId'] ?? '', 64), 'createdAt' => gmdate('c'), 'expiresAt' => gmdate('c', time() + 2592000)])) respond(['error' => 'Unable to activate assessment access.'], 500);
    setcookie('ngo_compass_access', $session, ['expires' => time() + 2592000, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']); redirectToApp('assessment/');
}
if ($method === 'GET' && $action === 'load') {
    $paymentId = requireAccess($sessionsDir); $id = cleanText($_GET['id'] ?? '', 128); $key = cleanText($_GET['key'] ?? '', 128); $record = validHexToken($id) && validHexToken($key) ? jsonRead(assessmentPath($dataDir, $id)) : null;
    if (!$record || !hash_equals((string) ($record['keyHash'] ?? ''), hashToken($key)) || !hash_equals((string) ($record['paymentId'] ?? ''), $paymentId)) respond(['error' => 'Assessment not found.'], 404); unset($record['keyHash'], $record['paymentId']); respond(['assessment' => $record]);
}
if ($method !== 'POST') respond(['error' => 'Method not allowed.'], 405);
requireCsrf(); $payload = requestBody(); $action = cleanText($payload['action'] ?? '', 40);

if ($action === 'payment') {
    if (!rateAllowed($dataDir, 'payment:' . cleanText($_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? 'unknown', 80), 5, 900)) respond(['error' => 'Too many attempts. Please try again later.'], 429);
    $profile = ['respondentName' => cleanText($payload['respondentName'] ?? '', 120), 'ngoName' => cleanText($payload['ngoName'] ?? '', 160), 'email' => strtolower(cleanText($payload['email'] ?? '', 160)), 'phoneNumber' => cleanText($payload['phoneNumber'] ?? '', 40)]; $utr = cleanText($payload['utr'] ?? '', 64); $proof = $payload['proof'] ?? null; $reference = cleanText($payload['orderReference'] ?? '', 32);
    if (!validProfile($profile) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9 .\/_-]{5,63}$/', $utr) || ($payload['consent'] ?? false) !== true || !validProof($proof)) respond(['error' => 'Please complete all required fields with valid details.'], 400);
    $order = preg_match('/^NGR-\d{8}-[A-Z0-9]{10}$/', $reference) ? jsonRead(orderPath($ordersDir, $reference)) : null; if (!$order || ($order['paymentId'] ?? '') !== '' || strtotime((string) ($order['expiresAt'] ?? '')) <= time()) respond(['error' => 'Your payment reference has expired. Refresh the page to create a new one.'], 409);
    foreach (glob($paymentsDir . '/payment-*.json') ?: [] as $file) { $existing = jsonRead($file); if ($existing && strcasecmp((string) ($existing['utr'] ?? ''), $utr) === 0) respond(['error' => 'This UPI transaction reference has already been submitted.'], 409); }
    $id = bin2hex(random_bytes(18)); $now = gmdate('c'); $record = ['id' => $id, 'orderReference' => $reference, 'profile' => $profile, 'utr' => $utr, 'proof' => is_array($proof) ? ['name' => cleanText($proof['name'] ?? '', 160), 'type' => cleanText($proof['type'] ?? '', 80), 'size' => (int) ($proof['size'] ?? 0), 'data' => (string) ($proof['data'] ?? '')] : ['name' => '', 'type' => '', 'size' => 0, 'data' => ''], 'consent' => true, 'status' => 'pending', 'reviewer' => '', 'reportDueAt' => '', 'reportSentAt' => '', 'assessmentId' => '', 'createdAt' => $now, 'updatedAt' => $now, 'verifiedAt' => ''];
    if (!jsonWriteAtomic(paymentPath($paymentsDir, $id), $record)) respond(['error' => 'We could not record your payment details. Please try again.'], 500); $order['paymentId'] = $id; jsonWriteAtomic(orderPath($ordersDir, $reference), $order); respond(['ok' => true, 'paymentId' => $id, 'orderReference' => $reference], 201);
}
if ($action === 'start') {
    $paymentId = requireAccess($sessionsDir); $profile = is_array($payload['profile'] ?? null) ? $payload['profile'] : []; $payment = jsonRead(paymentPath($paymentsDir, $paymentId));
    if (!validProfile($profile) || mb_strlen(cleanText($profile['position'] ?? '', 120)) < 2) respond(['error' => 'Please complete your profile first.'], 400); if (!$payment || ($payment['status'] ?? '') !== 'verified') respond(['error' => 'Assessment access is not active.'], 403); if (($payment['assessmentId'] ?? '') !== '') respond(['error' => 'This payment is already linked to an assessment.'], 409);
    $id = bin2hex(random_bytes(16)); $key = bin2hex(random_bytes(32)); $now = gmdate('c'); $record = ['id' => $id, 'paymentId' => $paymentId, 'profile' => ['respondentName' => cleanText($profile['respondentName'] ?? '', 120), 'ngoName' => cleanText($profile['ngoName'] ?? '', 160), 'email' => strtolower(cleanText($profile['email'] ?? '', 160)), 'phoneNumber' => cleanText($profile['phoneNumber'] ?? '', 40), 'position' => cleanText($profile['position'] ?? '', 120)], 'answers' => [], 'currentStep' => 0, 'completed' => false, 'createdAt' => $now, 'updatedAt' => $now, 'keyHash' => hashToken($key)];
    if (!jsonWriteAtomic(assessmentPath($dataDir, $id), $record)) respond(['error' => 'Unable to start the assessment.'], 500); $payment['assessmentId'] = $id; $payment['updatedAt'] = $now; jsonWriteAtomic(paymentPath($paymentsDir, $paymentId), $payment); respond(['id' => $id, 'respondentKey' => $key]);
}
if ($action !== 'save') respond(['error' => 'Invalid request.'], 400);
$paymentId = requireAccess($sessionsDir); $id = cleanText($payload['id'] ?? '', 128); $key = cleanText($payload['key'] ?? $payload['respondentKey'] ?? '', 128); $draft = is_array($payload['draft'] ?? null) ? $payload['draft'] : null; $record = validHexToken($id) && validHexToken($key) ? jsonRead(assessmentPath($dataDir, $id)) : null;
if (!$draft || !is_array($draft['profile'] ?? null) || !is_array($draft['answers'] ?? null) || !$record || !hash_equals((string) ($record['keyHash'] ?? ''), hashToken($key)) || !hash_equals((string) ($record['paymentId'] ?? ''), $paymentId)) respond(['error' => 'Invalid assessment data.'], 400);
$allowed = ['yes', 'no', 'not_sure', 'not_applicable']; $record['profile'] = ['respondentName' => cleanText($draft['profile']['respondentName'] ?? '', 120), 'ngoName' => cleanText($draft['profile']['ngoName'] ?? '', 160), 'email' => strtolower(cleanText($draft['profile']['email'] ?? '', 160)), 'phoneNumber' => cleanText($draft['profile']['phoneNumber'] ?? '', 40), 'position' => cleanText($draft['profile']['position'] ?? '', 120)]; $record['answers'] = array_filter($draft['answers'], static fn ($answer) => in_array($answer, $allowed, true)); $record['currentStep'] = max(0, min(94, (int) ($draft['currentStep'] ?? 0))); $record['completed'] = (bool) ($draft['completed'] ?? false); $record['updatedAt'] = gmdate('c');
if (!jsonWriteAtomic(assessmentPath($dataDir, $id), $record)) respond(['error' => 'Unable to save your progress.'], 500); if ($record['completed']) { $payment = jsonRead(paymentPath($paymentsDir, $paymentId)); if ($payment) { $payment['submittedAt'] = (string) ($payment['submittedAt'] ?? '') ?: gmdate('c'); $payment['updatedAt'] = gmdate('c'); jsonWriteAtomic(paymentPath($paymentsDir, $paymentId), $payment); } } respond(['ok' => true]);
