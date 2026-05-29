import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

const CODEBRAIN_HOME = join(homedir(), '.codebrain');

export interface CodeBrainConfig {
  llm: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
  };
  embedding: {
    provider: string;
    model: string;
  };
}

const DEFAULT_CONFIG: CodeBrainConfig = {
  llm: {
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
  embedding: {
    provider: 'xenova',
    model: 'MiniLM-L6-v2',
  },
};

export function loadConfig(configPath?: string): CodeBrainConfig {
  const path = configPath || join(CODEBRAIN_HOME, 'config.yaml');

  try {
    const raw = readFileSync(path, 'utf-8');
    const userConfig = parseYaml(raw) as Partial<CodeBrainConfig>;
    return mergeConfig(DEFAULT_CONFIG, userConfig);
  } catch {
    return DEFAULT_CONFIG;
  }
}

function mergeConfig(
  defaults: CodeBrainConfig,
  overrides: Partial<CodeBrainConfig>,
): CodeBrainConfig {
  return {
    llm: { ...defaults.llm, ...overrides.llm },
    embedding: { ...defaults.embedding, ...overrides.embedding },
  };
}
