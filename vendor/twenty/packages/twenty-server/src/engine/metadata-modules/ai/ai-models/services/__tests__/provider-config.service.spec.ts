import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { DefaultAiCatalogService } from 'src/engine/metadata-modules/ai/ai-models/services/default-ai-catalog.service';
import { ProviderConfigService } from 'src/engine/metadata-modules/ai/ai-models/services/provider-config.service';

describe('ProviderConfigService', () => {
  it('resolves catalog baseUrl templates for built-in providers from config variables', () => {
    const configValues: Record<string, string> = {
      OPENAI_API_KEY: 'sk-openai-test',
      OPENAI_BASE_URL: 'https://openai.example.com/v1',
      ANTHROPIC_API_KEY: 'sk-anthropic-test',
      ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
      GOOGLE_API_KEY: 'sk-google-test',
      GOOGLE_BASE_URL: 'https://google.example.com',
      MISTRAL_API_KEY: 'sk-mistral-test',
      MISTRAL_BASE_URL: 'https://mistral.example.com',
      XAI_API_KEY: 'sk-xai-test',
      XAI_BASE_URL: 'https://xai.example.com/v1',
    };

    const twentyConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'AI_PROVIDERS') {
          return {};
        }

        return configValues[key];
      }),
    } as unknown as TwentyConfigService;

    const defaultAiCatalogService = {
      getDefaultAiCatalog: jest.fn().mockReturnValue({
        openai: {
          npm: '@ai-sdk/openai',
          label: 'OpenAI',
          apiKey: '{{OPENAI_API_KEY}}',
          baseUrl: '{{OPENAI_BASE_URL}}',
          models: [],
        },
        anthropic: {
          npm: '@ai-sdk/anthropic',
          label: 'Anthropic',
          apiKey: '{{ANTHROPIC_API_KEY}}',
          baseUrl: '{{ANTHROPIC_BASE_URL}}',
          models: [],
        },
        google: {
          npm: '@ai-sdk/google',
          label: 'Google',
          apiKey: '{{GOOGLE_API_KEY}}',
          baseUrl: '{{GOOGLE_BASE_URL}}',
          models: [],
        },
        mistral: {
          npm: '@ai-sdk/mistral',
          label: 'Mistral',
          apiKey: '{{MISTRAL_API_KEY}}',
          baseUrl: '{{MISTRAL_BASE_URL}}',
          models: [],
        },
        xai: {
          npm: '@ai-sdk/xai',
          label: 'xAI',
          apiKey: '{{XAI_API_KEY}}',
          baseUrl: '{{XAI_BASE_URL}}',
          models: [],
        },
      }),
    } as unknown as DefaultAiCatalogService;

    const service = new ProviderConfigService(
      twentyConfigService,
      defaultAiCatalogService,
    );

    expect(service.getResolvedProviders()).toMatchObject({
      openai: {
        apiKey: 'sk-openai-test',
        baseUrl: 'https://openai.example.com/v1',
      },
      anthropic: {
        apiKey: 'sk-anthropic-test',
        baseUrl: 'https://anthropic.example.com',
      },
      google: {
        apiKey: 'sk-google-test',
        baseUrl: 'https://google.example.com',
      },
      mistral: {
        apiKey: 'sk-mistral-test',
        baseUrl: 'https://mistral.example.com',
      },
      xai: {
        apiKey: 'sk-xai-test',
        baseUrl: 'https://xai.example.com/v1',
      },
    });
  });
});
