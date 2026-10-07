<?php
declare(strict_types=1);

// Shared PHP runtime for Hostinger's /FundingReady/ directory. Never expose this file directly.
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

function storageRoot(): string {
    $configured = getenv('DATA_DIR');
    return is_string($configured) && $configured !== '' ? rtrim($configured, '/') : dirname(__DIR__, 4) . '/ngo-compass-funding-ready-data';
}
function storage(string $part = ''): string { return storageRoot() . ($part === '' ? '' : '/' . $part); }
function ensureStorage(): void {
    foreach (['', 'payments', 'orders', 'access', 'sessions', 'uploads', 'locks'] as $part) {
        $directory = storage($part);
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) fail('Private storage is unavailable.', 500);
    }
}
function fail(string $message, int $status = 400, array $extra = []): never { jsonResponse(['error' => $message] + $extra, $status); }
function jsonResponse(array $value, int $status = 200): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
    echo json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); exit;
}
function textValue(mixed $value, int $limit): string { return is_string($value) ? mb_substr(trim($value), 0, $limit) : ''; }
function token(int $bytes = 32): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function digest(string $value): string { return hash('sha256', $value); }
function now(): string { return gmdate('c'); }
function validId(mixed $value): bool { return is_string($value) && preg_match('/^[a-f0-9]{32,40}$/D', $value) === 1; }
function validToken(mixed $value): bool { return is_string($value) && preg_match('/^[A-Za-z0-9_-]{30,128}$/D', $value) === 1; }
function readJson(string $path): ?array {
    if (!is_file($path)) return null;
    $decoded = json_decode((string) file_get_contents($path), true);
    return is_array($decoded) ? $decoded : null;
}
function writeJson(string $path, array $value): bool {
    $temporary = tempnam(dirname($path), '.write-');
    if ($temporary === false) return false;
    $bytes = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($bytes === false || file_put_contents($temporary, $bytes, LOCK_EX) === false) { @unlink($temporary); return false; }
    @chmod($temporary, 0600);
    if (!@rename($temporary, $path)) { @unlink($temporary); return false; }
    return true;
}
function locked(string $name, callable $action): mixed {
    $file = fopen(storage('locks/' . digest($name) . '.lock'), 'c');
    if (!$file || !flock($file, LOCK_EX)) fail('Storage is unavailable.', 500);
    try { return $action(); } finally { flock($file, LOCK_UN); fclose($file); }
}
function paymentFile(string $id): string { return storage('payments/payment-' . $id . '.json'); }
function assessmentFile(string $id): string { return storage('assessment-' . $id . '.json'); }
function orderFile(string $reference): string { return storage('orders/order-' . $reference . '.json'); }
function appCookie(string $name, string $value, int $seconds, bool $httpOnly = true): void {
    $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    setcookie($name, $value, ['expires' => time() + $seconds, 'path' => '/', 'secure' => $https, 'httponly' => $httpOnly, 'samesite' => 'Lax']);
}
function csrfToken(): string {
    $current = $_COOKIE['ngo_compass_csrf'] ?? null;
    if (validToken($current)) return $current;
    $new = token(24); appCookie('ngo_compass_csrf', $new, 86400, false); return $new;
}
function requireCsrf(?string $formToken = null): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($origin !== '' && (!is_string($origin) || !is_string($host) || parse_url($origin, PHP_URL_HOST) !== explode(':', $host)[0])) fail('Invalid request origin.', 403);
    $provided = $formToken ?? ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    $cookie = $_COOKIE['ngo_compass_csrf'] ?? '';
    if (!validToken($provided) || !validToken($cookie) || !hash_equals($cookie, $provided)) fail('Invalid or missing CSRF token.', 403);
}
function requestJson(): array {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 10_000_000) fail('Request is too large.', 413);
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || strlen($raw) > 10_000_000) fail('Request is too large.', 413);
    $body = json_decode($raw, true);
    if (!is_array($body)) fail('Invalid JSON request.');
    return $body;
}
function paymentSettings(): array {
    $settings = readJson(storage('payment-settings.json')) ?: [];
    $payee = textValue($settings['payeeName'] ?? '', 160);
    $upi = textValue($settings['upiId'] ?? '', 160);
    $qr = $settings['qrDataUrl'] ?? '';
    if (!is_string($qr) || strlen($qr) > 2_000_000 || !preg_match('#^data:image/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$#D', $qr)) $qr = '';
    return ['available' => $payee !== '' && $upi !== '', 'payeeName' => $payee, 'upiId' => $upi, 'upiPhone' => textValue($settings['upiPhone'] ?? '', 40), 'qrDataUrl' => $qr];
}
function accessPaymentId(): string {
    $cookie = $_COOKIE['ngo_compass_access'] ?? null;
    if (!validToken($cookie)) return '';
    $session = readJson(storage('sessions/session-' . digest($cookie) . '.json'));
    if (!$session || strtotime((string) ($session['expiresAt'] ?? '')) <= time()) return '';
    $id = $session['paymentId'] ?? '';
    if (!validId($id)) return '';
    $payment = readJson(paymentFile($id));
    return $payment && ($payment['status'] ?? '') === 'verified' ? $id : '';
}
function requireAccess(): string { $id = accessPaymentId(); if ($id === '') fail('Assessment access is not active.', 403); return $id; }
function reviewerEmail(): string { return textValue(getenv('REVIEWER_EMAIL') ?: '', 160); }
function publicAssessment(array $record): array { unset($record['paymentId'], $record['keyHash'], $record['respondentKey']); return $record; }
function receipt(array $assessment, ?array $payment): ?array {
    if (($assessment['completed'] ?? false) !== true) return null;
    return ['reference' => $payment['orderReference'] ?? '', 'submittedAt' => $payment['submittedAt'] ?? $assessment['updatedAt'] ?? '', 'reviewStatus' => $payment['reviewStatus'] ?? 'submitted', 'reportReady' => !empty($payment['report']['file']), 'reviewerScore' => $payment['reviewerScore'] ?? null];
}
function questions(): array {
    static $all = null;
    if ($all !== null) return $all;
    $sections = json_decode((string) file_get_contents(__DIR__ . '/questions.json'), true);
    $all = [];
    foreach (is_array($sections) ? $sections : [] as $section) foreach (($section['questions'] ?? []) as $question) $all[$question['id']] = $question;
    return $all;
}
function applies(string $id, array $p): bool {
    if ($id === 'q7' && ($p['seekingCsr'] ?? '') === 'no') return false;
    if (in_array($id, ['q8','q8_registration','q8_prior_permission','q85','q86','q87','q88','q89'], true) && !in_array($p['fundingSources'] ?? '', ['international','both'], true)) return false;
    if (in_array($id, ['q9','q10','q11','q12','q25'], true) && ($p['completedFinancialYears'] ?? '') === '0') return false;
    if (in_array($id, ['q66','q67','q68'], true) && ($p['websitePresence'] ?? '') === 'no') return false;
    if ($id === 'q82' && ($p['fundingHistory'] ?? '') === 'no') return false;
    if (in_array($id, ['q40','q41','q42','q43'], true) && ($p['staffing'] ?? '') === 'volunteers_only') return false;
    if (in_array($id, ['q46','q57'], true) && ($p['programmeContext'] ?? '') === 'no_direct_contact') return false;
    return true;
}
function validateDraft(mixed $draft, bool $complete): array {
    if (!is_array($draft) || !is_array($draft['profile'] ?? null) || !is_array($draft['answers'] ?? null) || !is_array($draft['naReasons'] ?? null)) return [null, ['draft' => 'Invalid assessment.']];
    $errors = []; $profile = []; $answers = []; $reasons = [];
    $limits = ['respondentName'=>120,'ngoName'=>160,'email'=>160,'phoneNumber'=>40,'position'=>120,'entityType'=>32,'registrationYear'=>4,'completedFinancialYears'=>2,'staffing'=>32,'programmeContext'=>80,'websitePresence'=>16,'fundingHistory'=>16,'fundingSources'=>160,'seekingCsr'=>16,'evidenceUrl'=>1000];
    foreach ($draft['profile'] as $key => $value) {
        if (!isset($limits[$key]) || !is_string($value) || mb_strlen($value) > $limits[$key]) $errors['profile.' . $key] = 'Invalid profile value.';
        else $profile[$key] = trim($value);
    }
    $choices = ['yes','no','not_sure','not_applicable']; $known = questions();
    $retired = array_fill_keys(['q8_registration','q8_prior_permission','q45_committee','q45_process','q53_stories','q53_photos','q53_data','q60_mfa','q62_restore'], true);
    foreach ($draft['answers'] as $key => $value) {
        if ((!isset($known[$key]) && !isset($retired[$key])) || !in_array($value, $choices, true)) $errors['answers.' . $key] = 'Invalid answer.';
        else $answers[$key] = $value;
    }
    foreach ($draft['naReasons'] as $key => $value) {
        if ((!isset($known[$key]) && !isset($retired[$key])) || !is_string($value) || mb_strlen($value) > 500) $errors['naReasons.' . $key] = 'Invalid reason.';
        else $reasons[$key] = trim($value);
    }
    $options = ['entityType'=>['trust','society','section8','other','unsure'],'staffing'=>['employees','mixed','volunteers_only','unsure'],'programmeContext'=>['children','vulnerable_adults','general_direct_contact','no_direct_contact','unsure'],'websitePresence'=>['yes','no','unsure'],'fundingHistory'=>['yes','no','unsure'],'fundingSources'=>['domestic','international','both','unsure'],'seekingCsr'=>['yes','no','unsure']];
    foreach ($options as $key => $allowed) if (isset($profile[$key]) && $profile[$key] !== '' && !in_array($profile[$key], $allowed, true)) $errors['profile.' . $key] = 'Choose a valid option.';
    if (($profile['evidenceUrl'] ?? '') !== '' && !preg_match('#^https://[A-Za-z0-9.-]+(?:/|$)#', $profile['evidenceUrl'])) $errors['profile.evidenceUrl'] = 'Enter a secure HTTPS link.';
    if ($complete) {
        foreach (array_keys($limits) as $key) if ($key !== 'evidenceUrl' && ($profile[$key] ?? '') === '') $errors['profile.' . $key] = 'Required before submission.';
        if (($profile['email'] ?? '') !== '' && filter_var($profile['email'], FILTER_VALIDATE_EMAIL) === false) $errors['profile.email'] = 'Enter a valid email.';
        if (($profile['registrationYear'] ?? '') !== '' && !preg_match('/^(19|20)\d{2}$/D', $profile['registrationYear'])) $errors['profile.registrationYear'] = 'Enter a four-digit year.';
        if (($profile['completedFinancialYears'] ?? '') !== '' && !preg_match('/^\d{1,2}$/D', $profile['completedFinancialYears'])) $errors['profile.completedFinancialYears'] = 'Enter a number.';
        foreach ($known as $id => $question) if (applies($id, $profile)) {
            if (!isset($answers[$id])) $errors['answers.' . $id] = 'Choose an answer.';
            elseif ($answers[$id] === 'not_applicable' && ($reasons[$id] ?? '') === '') $errors['naReasons.' . $id] = 'Explain why this is not applicable.';
        }
    }
    return [['profile'=>$profile,'answers'=>$answers,'naReasons'=>$reasons], $errors];
}
function detectFileType(string $bytes): ?array {
    if (str_starts_with($bytes, '%PDF-')) return ['application/pdf','pdf'];
    if (str_starts_with($bytes, "\xFF\xD8\xFF")) return ['image/jpeg','jpg'];
    if (str_starts_with($bytes, "\x89PNG\r\n\x1A\n")) return ['image/png','png'];
    return null;
}
function attachment(string $file, string $name): never {
    if (!preg_match('/^[a-f0-9]{32,64}\.(?:pdf|png|jpg)$/D', $file)) fail('File not found.', 404);
    $path = storage('uploads/' . $file);
    if (!is_file($path)) fail('File not found.', 404);
    $type = match (pathinfo($file, PATHINFO_EXTENSION)) { 'pdf'=>'application/pdf','png'=>'image/png',default=>'image/jpeg' };
    header('Content-Type: ' . $type); header('Content-Disposition: attachment; filename="' . basename($name) . '"'); header('Cache-Control: no-store');
    readfile($path); exit;
}
ensureStorage();
