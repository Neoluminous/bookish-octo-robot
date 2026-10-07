import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 2;
const here = path.dirname(fileURLToPath(import.meta.url));
export const sections: Array<{ title: string; questions: Array<{ id: string; prompt: string; label: string }> }> = JSON.parse(fs.readFileSync(path.join(here, 'site/questions.json'), 'utf8'));
export const questions = sections.flatMap(section => section.questions);
const ids = new Set(questions.map(question => question.id));
// Keep answers from in-progress assessments created before the 89-question form.
const retiredIds = new Set(['q8_registration','q8_prior_permission','q45_committee','q45_process','q53_stories','q53_photos','q53_data','q60_mfa','q62_restore']);
const choices = new Set(['yes', 'no', 'not_sure', 'not_applicable']);
const profileLimits: Record<string, number> = {
  respondentName: 120, ngoName: 160, email: 160, phoneNumber: 40, position: 120,
  entityType: 32, registrationYear: 4, completedFinancialYears: 2,
  staffing: 32, programmeContext: 80, websitePresence: 16,
  fundingHistory: 16, fundingSources: 160, seekingCsr: 16, evidenceUrl: 1000,
};

export function applicable(id: string, profile: Record<string, any>): boolean {
  if (id === 'q7' && profile.seekingCsr === 'no') return false;
  if (['q8','q8_registration','q8_prior_permission'].includes(id) && !['international','both'].includes(profile.fundingSources)) return false;
  if (['q9','q10','q11','q12','q25'].includes(id) && profile.completedFinancialYears === '0') return false;
  if (['q66', 'q67', 'q68'].includes(id) && profile.websitePresence === 'no') return false;
  if (id === 'q82' && profile.fundingHistory === 'no') return false;
  if (['q85', 'q86', 'q87', 'q88', 'q89'].includes(id) && !['international','both'].includes(profile.fundingSources)) return false;
  if (['q40', 'q41', 'q42', 'q43'].includes(id) && profile.staffing === 'volunteers_only') return false;
  if (['q46', 'q57'].includes(id) && profile.programmeContext === 'no_direct_contact') return false;
  return true;
}

export function validateDraft(draft: any, completing: boolean) {
  const errors: Record<string, string> = {};
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { draft: null, errors: { draft: 'Invalid assessment.' } };
  const inputProfile = draft.profile;
  const inputAnswers = draft.answers;
  const inputReasons = draft.naReasons || {};
  if (!inputProfile || typeof inputProfile !== 'object' || Array.isArray(inputProfile)) errors.profile = 'Profile is required.';
  if (!inputAnswers || typeof inputAnswers !== 'object' || Array.isArray(inputAnswers)) errors.answers = 'Answers must be an object.';
  if (!inputReasons || typeof inputReasons !== 'object' || Array.isArray(inputReasons)) errors.naReasons = 'Reasons must be an object.';
  const profile: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputProfile || {})) {
    if (!(key in profileLimits) || typeof value !== 'string' || value.length > profileLimits[key]) errors[`profile.${key}`] = 'Invalid profile value.';
    else profile[key] = value.trim();
  }
  const allowedProfile: Record<string, string[]> = {
    entityType: ['trust','society','section8','other','unsure'],
    staffing: ['employees','mixed','volunteers_only','unsure'],
    programmeContext: ['children','vulnerable_adults','general_direct_contact','no_direct_contact','unsure'],
    websitePresence: ['yes','no','unsure'], fundingHistory: ['yes','no','unsure'],
    fundingSources: ['domestic','international','both','unsure'], seekingCsr: ['yes','no','unsure'],
  };
  for (const [key, options] of Object.entries(allowedProfile)) if (profile[key] && !options.includes(profile[key])) errors[`profile.${key}`] = 'Choose a valid option.';
  if (profile.evidenceUrl && !/^https:\/\/[A-Za-z0-9.-]+(?:\/|$)/.test(profile.evidenceUrl)) errors['profile.evidenceUrl'] = 'Enter a secure HTTPS link.';
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputAnswers || {})) {
    if ((!ids.has(key) && !retiredIds.has(key)) || typeof value !== 'string' || !choices.has(value)) errors[`answers.${key}`] = 'Invalid answer.';
    else answers[key] = value;
  }
  const naReasons: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputReasons || {})) {
    if ((!ids.has(key) && !retiredIds.has(key)) || typeof value !== 'string' || value.length > 500) errors[`naReasons.${key}`] = 'Invalid reason.';
    else naReasons[key] = value.trim();
  }
  if (completing) {
    for (const key of ['respondentName', 'ngoName', 'email', 'phoneNumber', 'position', 'entityType', 'registrationYear', 'completedFinancialYears', 'staffing', 'programmeContext', 'websitePresence', 'fundingHistory', 'fundingSources', 'seekingCsr']) {
      if (!profile[key]) errors[`profile.${key}`] = 'Required before submission.';
    }
    if (profile.email && !/^\S+@\S+\.\S+$/.test(profile.email)) errors['profile.email'] = 'Enter a valid email.';
    if (profile.registrationYear && !/^(19|20)\d{2}$/.test(profile.registrationYear)) errors['profile.registrationYear'] = 'Enter a four-digit year.';
    if (profile.completedFinancialYears && !/^\d{1,2}$/.test(profile.completedFinancialYears)) errors['profile.completedFinancialYears'] = 'Enter a number.';
    for (const question of questions) {
      if (applicable(question.id, profile) && (!answers[question.id] || answers[question.id] === 'not_sure')) errors[`answers.${question.id}`] = 'Choose an answer.';
      if (applicable(question.id, profile) && answers[question.id] === 'not_applicable' && !naReasons[question.id]) errors[`naReasons.${question.id}`] = 'Explain why this is not applicable.';
    }
  }
  return { draft: { profile, answers, naReasons }, errors };
}
