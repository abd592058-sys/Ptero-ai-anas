export interface ModelConfig {
  id: string;
  label: string;
  keyConst: string;
  envVar?: string;
  provider: string;
  isPaid: boolean;
  apiUrl: string;
  apiModel: string;
  supportsImages: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsJson?: boolean;
  supportsLongContext?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  sampling?: {
    temperature?: number;
    top_p?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
  };
  logo: string;
}

export interface LanguageConfig {
  code: string;
  label: string;
  name: string;
  dir: 'ltr' | 'rtl';
}

export interface FeaturedBadge {
  link: string;
  img: string;
  alt: string;
  label?: string;
  width: string;
  height: string;
  rel: string;
  new_tab: boolean;
}

export const DEFAULT_MODEL = 'ling-3.0-flash:free';
export const DEFAULT_API_URL = 'https://tokenharbor.ai/v1/chat/completions';
export const WEBCLAW_API_URL = 'https://api.webclaw.io/v1/scrape';

export const UNAVAILABLE_SECONDS = 60;
export const MAX_FAILOVER_ATTEMPTS = 3;
export const PROVIDER_TIMEOUT_MS = 45_000;
export const MAX_CONCURRENT_REQUESTS = 8;

export const MAX_HISTORY_CHARS = 10_000_000;
export const QUICK_HISTORY_CHARS = 24_000;
export const FAST_HISTORY_CHARS = 1_000_000;
export const COMPLEX_HISTORY_CHARS = 5_000_000;

export const MAX_OUTPUT_TOKENS = 128_000;
export const QUICK_OUTPUT_TOKENS = 4_096;
export const FAST_OUTPUT_TOKENS = 32_768;
export const COMPLEX_OUTPUT_TOKENS = 65_536;
export const MERCURY_MAX_OUTPUT_TOKENS = 8_192;

export const CODE_CHUNK_MAX_LINES = 500;
export const CODE_CHUNK_MAX_CHARS = 100_000;
export const CODE_MAX_FILES = 500;
export const CODE_MAX_CHUNKS = 100;
export const CODE_OVERVIEW_MAX_CHUNKS = 12;
export const CODE_MAX_CONTEXT_CHARS = 1_200_000;

export const ARCHIVE_MAX_FILES = 100;
export const ARCHIVE_MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
export const ARCHIVE_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const ARCHIVE_MAX_TEXT_CHARS = 60_000;

export const RATE_LIMIT_PER_MINUTE = 30;
export const TOKEN_QUOTA_LIMIT = 1_000_000;
export const TOKEN_QUOTA_WINDOW_SECONDS = 3600;

export const MODELS: Record<string, ModelConfig> = {
  'ling-3.0-flash:free': {
    id: 'ling-3.0-flash:free',
    label: 'Ling 3.0 Flash (Free)',
    keyConst: 'MLP_MINIROUTER_KEY',
    envVar: 'MINIROUTER_KEY',
    provider: 'minirouter',
    isPaid: false,
    apiUrl: 'https://api.minirouter.sh/v1/chat/completions',
    apiModel: 'inclusionai/ling-3.0-flash',
    supportsImages: false,
    supportsTools: true,
    supportsStreaming: true,
    logo: 'https://ptero.pro/wp-content/uploads/2026/09/images.jpg',
  },
  'deepseek-v4.1-flash:free': {
    id: 'deepseek-v4.1-flash:free',
    label: 'Deepseek v4.1 Flash (Free)',
    keyConst: 'MLP_MODELRUNNER_KEY',
    provider: 'modelrunner',
    isPaid: false,
    apiUrl: 'https://queue.modelrunner.run/deepseek/v4.1-flash/chat/completions',
    apiModel: 'deepseek/v4.1-flash',
    supportsImages: true,
    supportsTools: false,
    supportsStreaming: true,
    supportsJson: true,
    sampling: { temperature: 0.7 },
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/DeepSeek-Emblem-1.png',
  },
  'atria-dawn-preview': {
    id: 'atria-dawn-preview',
    label: 'Atria-Dawn-Preview (Free)',
    keyConst: 'MLP_ATRIA_KEY',
    provider: 'atria',
    isPaid: false,
    apiUrl: 'https://api.atria-asi.ai/v1/chat/completions',
    apiModel: 'Atria-Dawn-Preview',
    supportsImages: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsJson: true,
    supportsLongContext: true,
    contextWindow: 256000,
    maxOutput: 65536,
    logo: 'https://www.atria-asi.ai/assets/atria-logo.png',
  },
  'agnes-2.5-flash:free': {
    id: 'agnes-2.5-flash:free',
    label: 'Agnes 2.5 Flash (Free)',
    keyConst: 'MLP_AGNES_SITE_KEY',
    provider: 'agnes-ai',
    isPaid: false,
    apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
    apiModel: 'agnes-2.5-flash',
    supportsImages: true,
    supportsTools: false,
    supportsStreaming: true,
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/biglogo.png',
  },
  'agnes-3.0-flash:free': {
    id: 'agnes-3.0-flash:free',
    label: 'Agnes 3.0 Flash (Free)',
    keyConst: 'MLP_AGNES_SITE_KEY',
    provider: 'agnes-ai',
    isPaid: false,
    apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
    apiModel: 'agnes-3.0-flash',
    supportsImages: true,
    supportsTools: false,
    supportsStreaming: true,
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/biglogo.png',
  },
  'mistral-nemo:minirouter': {
    id: 'mistral-nemo:minirouter',
    label: 'Mistral Nemo 12B',
    keyConst: 'MLP_MINIROUTER_KEY',
    envVar: 'MINIROUTER_KEY',
    provider: 'minirouter',
    isPaid: false,
    apiUrl: 'https://api.minirouter.sh/v1/chat/completions',
    apiModel: 'mistral/mistral-nemo',
    supportsImages: false,
    supportsTools: true,
    supportsStreaming: true,
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/announcing-mistral.png',
  },
  'deepseek-v4-flash-0731': {
    id: 'deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash 0731',
    keyConst: 'MLP_SEEKAI_KEY',
    provider: 'seekai',
    isPaid: false,
    apiUrl: 'https://seekai.cc/v1/chat/completions',
    apiModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    supportsImages: false,
    supportsTools: false,
    supportsStreaming: true,
    supportsJson: true,
    sampling: { temperature: 0.7 },
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/DeepSeek-Emblem-1.png',
  },
  'gpt-oss-20b': {
    id: 'gpt-oss-20b',
    label: 'GPT-OSS 20B',
    keyConst: 'MLP_BLUESMINDS_KEY',
    provider: 'bluesminds',
    isPaid: false,
    apiUrl: 'https://api.bluesminds.com/v1/chat/completions',
    apiModel: 'openai/gpt-oss-20b',
    supportsImages: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsJson: true,
    logo: 'https://ptero.pro/wp-content/uploads/2026/08/images-2.png',
  },
  'apodex-1.1-mini:free': {
    id: 'apodex-1.1-mini:free',
    label: 'Apodex 1.1 Mini (Free)',
    keyConst: 'MLP_APODEX_KEY',
    provider: 'apodex',
    isPaid: false,
    apiUrl: 'https://api.apodex.ai/v1/chat/completions',
    apiModel: 'apodex-1.1-mini',
    supportsImages: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsJson: true,
    supportsLongContext: true,
    contextWindow: 262144,
    maxOutput: 32768,
    logo: 'https://ptero.pro/wp-content/uploads/2026/10/276468590.jpg',
  },
};

export const LANGUAGES: LanguageConfig[] = [
  { code: 'fa', label: 'فارسی (Persian)', name: 'Persian', dir: 'rtl' },
  { code: 'en', label: 'English', name: 'English', dir: 'ltr' },
  { code: 'ar', label: 'العربية (Arabic)', name: 'Arabic', dir: 'rtl' },
  { code: 'zh', label: '中文 (Chinese)', name: 'Chinese (Simplified)', dir: 'ltr' },
  { code: 'es', label: 'Español (Spanish)', name: 'Spanish', dir: 'ltr' },
  { code: 'fr', label: 'Français (French)', name: 'French', dir: 'ltr' },
  { code: 'de', label: 'Deutsch (German)', name: 'German', dir: 'ltr' },
  { code: 'pt', label: 'Português (Portuguese)', name: 'Portuguese', dir: 'ltr' },
  { code: 'ru', label: 'Русский (Russian)', name: 'Russian', dir: 'ltr' },
  { code: 'hi', label: 'हिन्दी (Hindi)', name: 'Hindi', dir: 'ltr' },
  { code: 'ja', label: '日本語 (Japanese)', name: 'Japanese', dir: 'ltr' },
  { code: 'ko', label: '한국어 (Korean)', name: 'Korean', dir: 'ltr' },
  { code: 'tr', label: 'Türkçe (Turkish)', name: 'Turkish', dir: 'ltr' },
  { code: 'it', label: 'Italiano (Italian)', name: 'Italian', dir: 'ltr' },
  { code: 'id', label: 'Bahasa Indonesia', name: 'Indonesian', dir: 'ltr' },
  { code: 'nl', label: 'Nederlands (Dutch)', name: 'Dutch', dir: 'ltr' },
  { code: 'vi', label: 'Tiếng Việt (Vietnamese)', name: 'Vietnamese', dir: 'ltr' },
  { code: 'pl', label: 'Polski (Polish)', name: 'Polish', dir: 'ltr' },
  { code: 'uk', label: 'Українська (Ukrainian)', name: 'Ukrainian', dir: 'ltr' },
  { code: 'bn', label: 'বাংলা (Bengali)', name: 'Bengali', dir: 'ltr' },
  { code: 'sv', label: 'Svenska (Swedish)', name: 'Swedish', dir: 'ltr' },
];

export const FEATURED_BADGES: FeaturedBadge[] = [
  { link: 'https://tools.launchllama.co?utm_source=badge&utm_medium=referral', img: 'https://tools.launchllama.co/featured-badge.png?v=2', alt: 'As seen on Launch Llama Newsletter', width: '200', height: '50', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://neeed.directory', img: 'https://neeed.directory/badges/neeed-badge-light.svg', alt: 'Featured on neeed.directory', width: '139', height: '', rel: 'noopener', new_tab: true },
  { link: 'https://noonlaunch.com/product/ptero', img: 'https://noonlaunch.com/badges/ptero.svg', alt: 'Featured on Noonlaunch', width: '220', height: '60', rel: 'dofollow', new_tab: false },
  { link: 'https://nicklaunches.com/products/ptero/?utm_source=ptero.pro&utm_medium=badge&utm_campaign=featured', img: 'https://nicklaunches.com/badges/featured.png', alt: 'Ptero on Nick Launches', width: '244', height: '56', rel: 'noopener', new_tab: true },
  { link: 'https://dang.ai', img: 'https://assets.dang.ai/badges/dang-verified-dark.png', alt: 'Verified on DANG!', width: '260', height: '94', rel: 'dofollow noopener', new_tab: true },
  { link: 'https://saasgrow.ai/tools/ptero', img: 'https://saasgrow.ai/badge/dark.svg', alt: 'Ptero is featured on saasgrow.ai', width: '200', height: '54', rel: 'noopener', new_tab: true },
  { link: 'https://startupfa.st', img: 'https://startupfa.st/images/badges/powered-by-light.svg', alt: 'Powered by Startup Fast', width: '150', height: '44', rel: '', new_tab: true },
  { link: 'https://findly.tools/ptero?utm_source=ptero', img: 'https://findly.tools/badges/findly-tools-badge-light.svg', alt: 'Featured on Findly.tools', width: '175', height: '55', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://dailypings.com/p/ptero', img: 'https://dailypings.com/badge.svg', alt: 'Featured on DailyPings', width: '179', height: '32', rel: 'noopener', new_tab: true },
  { link: 'https://turbo0.com/item/ptero', img: 'https://img.turbo0.com/badge-listed-light.svg', alt: 'Listed on Turbo0', width: '', height: '54', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://www.toolpilot.ai/', img: 'https://ptero.pro/wp-content/uploads/2026/08/f-w_690x151_crop_center.png', alt: 'Listed on ToolPilot', width: '', height: '54', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://wired.business', img: 'https://wired.business/badge1-light.svg', alt: 'Featured on Wired Business', width: '200', height: '54', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://showmebest.ai', img: 'https://showmebest.ai/badge/feature-badge-white.webp', alt: 'Featured on ShowMeBestAI', width: '220', height: '60', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://submitaitools.org', img: 'https://submitaitools.org/static_submitaitools/images/submitaitools.png', alt: 'Submit AI Tools', width: '200', height: '60', rel: 'noopener noreferrer', new_tab: true },
  { link: 'https://goodaitools.com/ai/ptero', img: 'https://goodaitools.com/assets/images/badge.png', alt: 'Good AI Tools', width: '', height: '54', rel: '', new_tab: true },
  { link: 'https://www.foundrlist.com/product/ptero?utm_source=badge&utm_medium=embed', img: 'https://www.foundrlist.com/api/badge/ptero', alt: 'Featured on FoundrList', width: '150', height: '48', rel: 'noopener', new_tab: true },
  { link: 'https://deeplaunch.io', img: 'https://deeplaunch.io/badge/badge_dark.svg', alt: 'Featured on DeepLaunch.io', width: '200', height: '54', rel: '', new_tab: true },
  { link: 'https://superlaunchlist.com?ref=https%3A%2F%2Fptero.pro', img: 'https://superlaunchlist.com/badge.svg', alt: 'Featured on SuperLaunch List', width: '174', height: '42', rel: 'noopener', new_tab: true },
];

export const MODE_INSTRUCTIONS: Record<string, string> = {
  fast: 'FAST TASK MODE: Make a sensible assumption, give a one-sentence plan when useful, and deliver the smallest complete result. Skip narration about work that was not actually performed.',
  complex: 'COMPLEX MODE: Work methodically through architecture, dependencies, edge cases, and verification. Explain only important tradeoffs, then provide a complete result. For long code, preserve every required section; the server will finish a length-limited response invisibly.',
  quick: 'QUICK ANSWER MODE: Give the shortest correct answer or smallest complete change. Skip planning and extended explanation unless they are necessary for correctness.',
  full: 'FULL OUTPUT MODE: Prioritize a complete, copy-ready result. For source files, include every required line with no placeholders or omitted sections. Continue from the exact next character if the output limit is reached.',
};

export const API_USAGE_POLICY_HTML =
  '<strong>Requests Per Day:</strong> <span style="color: #b8860b; font-weight: bold;">Depends on provider</span> &nbsp;|&nbsp; ' +
  '<strong>Token Quota:</strong> 1,000,000 tokens / hour (for API keys and web platform).';

export function getApiKeyForModel(modelId: string): { key: string; url: string; apiModel: string } | { error: string; status: number } {
  const cfg = MODELS[modelId];
  if (!cfg) {
    return { error: `Unknown model: ${modelId}`, status: 400 };
  }
  const directKey =
    (cfg.keyConst && process.env[cfg.keyConst]?.trim()) ||
    (cfg.envVar && process.env[cfg.envVar]?.trim()) ||
    '';
  if (directKey) {
    return { key: directKey, url: cfg.apiUrl || DEFAULT_API_URL, apiModel: cfg.apiModel || modelId };
  }
  const fallbackKey = process.env.OPENAI_API_KEY?.trim() || '';
  if (fallbackKey) {
    return {
      key: fallbackKey,
      url: process.env.OPENAI_API_URL?.trim() || cfg.apiUrl || DEFAULT_API_URL,
      apiModel: cfg.apiModel || modelId,
    };
  }
  const configHint = cfg.envVar ? `environment variable ${cfg.envVar} or ${cfg.keyConst}` : `environment variable ${cfg.keyConst}`;
  return {
    error: `API key ${configHint} is not configured.`,
    status: 500,
  };
}

export function cleanModelLabel(label: string): string {
  return label.replace(/\s*\(free\)\s*$/i, '').trim();
}
