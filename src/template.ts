import fs from 'node:fs';
import path from 'node:path';
import {
  API_USAGE_POLICY_HTML,
  cleanModelLabel,
  DEFAULT_MODEL,
  FEATURED_BADGES,
  getApiKeyForModel,
  LANGUAGES,
  MODELS,
} from './config.js';

interface LegalData {
  tos: Record<string, string>;
  privacy: Record<string, string>;
}

const rootDir = process.cwd();
const mainFragment = fs.readFileSync(path.join(rootDir, 'views', 'main-fragment.html'), 'utf8');
const footerFragment = fs.readFileSync(path.join(rootDir, 'views', 'footer-fragments.html'), 'utf8');
const legalData = JSON.parse(fs.readFileSync(path.join(rootDir, 'src', 'data', 'legal.json'), 'utf8')) as LegalData;
const referralI18n = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'src', 'data', 'referral-i18n.json'), 'utf8')
) as Record<string, Record<string, string>>;

const LEGAL_TITLES: Record<string, { tos: string; privacy: string }> = {
  en: { tos: 'Terms of Service', privacy: 'Privacy Policy' },
  ar: { tos: 'شروط الخدمة', privacy: 'سياسة الخصوصية' },
  zh: { tos: '服务条款', privacy: '隐私政策' },
  es: { tos: 'Términos de servicio', privacy: 'Política de privacidad' },
  fr: { tos: 'Conditions d’utilisation', privacy: 'Politique de confidentialité' },
  de: { tos: 'Nutzungsbedingungen', privacy: 'Datenschutzerklärung' },
  pt: { tos: 'Termos de Serviço', privacy: 'Política de Privacidade' },
  ru: { tos: 'Условия использования', privacy: 'Политика конфиденциальности' },
  hi: { tos: 'सेवा की शर्तें', privacy: 'गोपनीयता नीति' },
  ja: { tos: '利用規約', privacy: 'プライバシーポリシー' },
  ko: { tos: '서비스 약관', privacy: '개인정보 처리방침' },
  tr: { tos: 'Hizmet Şartları', privacy: 'Gizlilik Politikası' },
  it: { tos: 'Termini di servizio', privacy: 'Informativa sulla privacy' },
  id: { tos: 'Ketentuan Layanan', privacy: 'Kebijakan Privasi' },
  nl: { tos: 'Servicevoorwaarden', privacy: 'Privacybeleid' },
  vi: { tos: 'Điều khoản dịch vụ', privacy: 'Chính sách quyền riêng tư' },
  pl: { tos: 'Warunki korzystania z usługi', privacy: 'Polityka prywatności' },
  uk: { tos: 'Умови використання', privacy: 'Політика конфіденциальності' },
  bn: { tos: 'সেবার শর্তাবলি', privacy: 'গोपनीयता নীতি' },
  sv: { tos: 'Användarvillkor', privacy: 'Integritetspolicy' },
  fa: { tos: 'شرایط استفاده از خدمات', privacy: 'سیاست حفظ حریم خصوصی' },
};

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildLangOptionsHtml(): string {
  return LANGUAGES.map(
    (l) => `<option value="${escapeHtml(l.code)}"${l.code === 'en' ? ' selected' : ''}>${escapeHtml(l.label)}</option>`
  ).join('');
}

function buildFeaturedBadgesHtml(): string {
  return FEATURED_BADGES.map((b) => {
    const target = b.new_tab ? ' target="_blank"' : '';
    const rel = b.rel ? ` rel="${escapeHtml(b.rel)}"` : '';
    const imgHtml = b.img
      ? `<img src="${escapeHtml(b.img)}" alt="${escapeHtml(b.alt)}"${b.width ? ` width="${escapeHtml(b.width)}"` : ''}${b.height ? ` height="${escapeHtml(b.height)}"` : ''} loading="lazy" decoding="async">`
      : `<span>${escapeHtml(b.label || b.alt)}</span>`;
    return `<a href="${escapeHtml(b.link)}"${target}${rel} class="chat-featured-on-badge">${imgHtml}</a>`;
  }).join('');
}

function buildApiModelsHtml(): string {
  const configured = Object.values(MODELS)
    .filter((m) => !('error' in getApiKeyForModel(m.id)))
    .map((m) => `<li><strong>${escapeHtml(m.label)}</strong> <code>${escapeHtml(m.id)}</code></li>`);
  if (configured.length === 0) {
    return Object.values(MODELS)
      .map((m) => `<li><strong>${escapeHtml(m.label)}</strong> <code>${escapeHtml(m.id)}</code></li>`)
      .join('');
  }
  return configured.join('');
}

function buildModelPickerOptionsHtml(): string {
  return Object.values(MODELS)
    .map((m) => {
      const cleanLabel = cleanModelLabel(m.label);
      const isDefault = m.id === DEFAULT_MODEL;
      const iconHtml = m.logo
        ? `<img src="${escapeHtml(m.logo)}" alt="" loading="eager" decoding="async" width="32" height="32">`
        : `<span class="chat-model-picker-option-icon-fallback">${escapeHtml(cleanLabel.slice(0, 1).toUpperCase())}</span>`;
      const freeBadge = !m.isPaid ? '<span class="chat-model-picker-option-badge">Free</span>' : '';
      return (
        `<div class="chat-model-picker-option${isDefault ? ' is-selected' : ''}" role="option" aria-selected="${isDefault ? 'true' : 'false'}" data-value="${escapeHtml(m.id)}" data-label="${escapeHtml(cleanLabel)}" tabindex="-1">` +
        `<span class="chat-model-picker-option-icon">${iconHtml}</span>` +
        `<span class="chat-model-picker-option-main"><span class="chat-model-picker-option-label">${escapeHtml(cleanLabel)}</span></span>` +
        `${freeBadge}</div>`
      );
    })
    .join('');
}

function buildModelSelectOptionsHtml(): string {
  return Object.values(MODELS)
    .map((m) => {
      const cleanLabel = cleanModelLabel(m.label);
      const selected = m.id === DEFAULT_MODEL ? ' selected' : '';
      return `<option value="${escapeHtml(m.id)}" data-logo="${escapeHtml(m.logo || '')}" data-clean-label="${escapeHtml(cleanLabel)}"${selected}>${escapeHtml(cleanLabel)}</option>`;
    })
    .join('');
}

function buildApiDocsHtml(origin: string): string {
  return `
<div style="margin-top:10px;">
  <div class="chat-api-doc-section" style="margin:20px 0 0;padding-top:14px;border-top:1px solid rgba(127,127,127,.25);">
    <p class="chat-settings-muted"><strong>OpenAI-compatible REST API</strong></p>
    <p class="chat-settings-muted">Send either <code>Authorization: Bearer YOUR_API_KEY</code> or <code>X-API-Key: YOUR_API_KEY</code>.</p>
    <p class="chat-settings-muted"><strong>Base URL:</strong> <code>${escapeHtml(origin)}/mlp/v1</code></p>
    <ul style="margin:0 0 14px 18px;padding:0;font-size:12px;line-height:1.8;">
      <li><code>POST /mlp/v1/chat/completions</code> — standard Chat Completions requests using <code>messages</code>.</li>
      <li><code>POST /mlp/v1/responses</code> — Responses API requests using string or structured <code>input</code>.</li>
      <li><code>GET /mlp/v1/models</code> — configured models and supported aliases.</li>
    </ul>
    <p class="chat-settings-muted"><strong>Streaming:</strong> set <code>stream: true</code> on <code>/chat/completions</code> to receive Server-Sent Events with standard <code>chat.completion.chunk</code> frames followed by <code>data: [DONE]</code>.</p>
  </div>
</div>`;
}

function buildLegalDocumentsJson(): string {
  const docs: Record<string, { tos: string; privacy: string; titles: { tos: string; privacy: string } }> = {};
  for (const [code, titles] of Object.entries(LEGAL_TITLES)) {
    docs[code] = {
      tos: legalData.tos[code] || legalData.tos.en || '',
      privacy: legalData.privacy[code] || legalData.privacy.en || '',
      titles,
    };
  }
  return JSON.stringify(docs);
}

export function renderAppHtml(origin: string): string {
  const turnstileSiteKey = process.env.MLP_TURNSTILE_SITE_KEY?.trim() || '';
  const githubOauthConfigured = Boolean(
    process.env.MLP_GITHUB_CLIENT_ID?.trim() && process.env.MLP_GITHUB_CLIENT_SECRET?.trim()
  );

  const jsModels = Object.values(MODELS).map((m) => ({
    id: m.id,
    label: m.label,
    supports_images: m.supportsImages,
    is_paid: m.isPaid,
    logo: m.logo,
  }));

  const jsLanguages = LANGUAGES.map((l) => ({
    code: l.code,
    label: l.label,
    dir: l.dir,
  }));

  const freeVisionModelIds = Object.values(MODELS)
    .filter((m) => m.supportsImages && !m.isPaid)
    .map((m) => m.id);

  const defaultLabel = cleanModelLabel(MODELS[DEFAULT_MODEL]?.label || 'Choose model');

  const nonce = 'ptero-node-nonce';

  const replacements: Record<string, string> = {
    '{{LANG_OPTIONS_HTML}}': buildLangOptionsHtml(),
    '{{TURNSTILE_WIDGET_HTML}}': turnstileSiteKey
      ? '<div id="chat-turnstile" class="chat-turnstile-widget"></div>'
      : '',
    '{{TURNSTILE_SUBMIT_ATTR}}': turnstileSiteKey ? ' disabled' : '',
    '{{TOS_EN_HTML}}': legalData.tos.en || '',
    '{{PRIVACY_EN_HTML}}': legalData.privacy.en || '',
    '{{FEATURED_BADGES_HTML}}': buildFeaturedBadgesHtml(),
    '{{NONCE}}': nonce,
    '{{USAGE_POLICY_HTML}}': API_USAGE_POLICY_HTML,
    '{{API_MODELS_HTML}}': buildApiModelsHtml(),
    '{{ORIGIN}}': origin,
    '{{API_DOCS_HTML}}': buildApiDocsHtml(origin),
    '{{DEFAULT_MODEL_LABEL}}': escapeHtml(defaultLabel),
    '{{MODEL_PICKER_OPTIONS_HTML}}': buildModelPickerOptionsHtml(),
    '{{MODEL_SELECT_OPTIONS_HTML}}': buildModelSelectOptionsHtml(),
    '{{JS_MODELS_JSON}}': JSON.stringify(jsModels),
    '{{GITHUB_OAUTH_CONFIGURED}}': githubOauthConfigured ? 'true' : 'false',
    '{{JS_LANGUAGES_JSON}}': JSON.stringify(jsLanguages),
    '{{LEGAL_DOCUMENTS_JSON}}': buildLegalDocumentsJson(),
    '{{TURNSTILE_SITE_KEY_JSON}}': JSON.stringify(turnstileSiteKey),
    '{{REFERRAL_I18N_JSON}}': JSON.stringify(referralI18n),
    '{{FREE_VISION_MODELS_JSON}}': JSON.stringify(freeVisionModelIds),
  };

  let bodyHtml = mainFragment + '\n' + footerFragment;
  for (const [token, val] of Object.entries(replacements)) {
    bodyHtml = bodyHtml.split(token).join(val);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Ptero AI Chat — Free, Multi-Model AI Chat Platform</title>
  <meta name="description" content="Ptero is a free, open-source AI chat platform with instant access to multiple language models, projects, media library, MCP integrations, and OpenAI-compatible API.">
  <meta property="og:title" content="Ptero AI Chat">
  <meta property="og:description" content="Multi-model AI chat workspace with projects, code syntax checks, MCP tools, and streaming responses.">
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
