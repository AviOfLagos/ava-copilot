import { createLogger } from '../log';
import {
  listeningHint,
  type ProviderConfig,
  speechToTextModelStore,
  voiceIdentityStore,
  voiceLanguageOf,
} from '@extension/storage';
import { t } from '@extension/i18n';
import type { ChatModel } from '../llm/types';
import { generatePlainText } from '../llm/generate';
import { createSpeechToTextModel } from '../llm/providers';
import { geminiSpeechConfig } from './geminiSpeech';
import { textPart, userMessage } from '../llm/messages';

const logger = createLogger('SpeechToText');

export class SpeechToTextService {
  private llm: ChatModel;

  private constructor(llm: ChatModel) {
    this.llm = llm;
  }

  static async create(providers: Record<string, ProviderConfig>): Promise<SpeechToTextService> {
    try {
      const config = geminiSpeechConfig(await speechToTextModelStore.getSpeechToTextModel(), providers);
      if (!config) throw new Error(t('chat_stt_model_notFound'));

      const provider = providers[config.provider];
      logger.info('Found provider for speech-to-text:', provider.type);

      const llm = createSpeechToTextModel(config.provider, provider.apiKey, config.modelName, provider.baseUrl);
      logger.info(`Speech-to-text service created with model: ${config.modelName}`);
      return new SpeechToTextService(llm);
    } catch (error) {
      logger.error('Failed to create speech-to-text service:', error);
      throw error;
    }
  }

  async transcribeAudio(
    base64Audio: string,
    mediaType = 'audio/webm',
    spoken?: string | null,
    // The user's own names and terms, from the vocabulary
    vocabularyHint?: string,
  ): Promise<string> {
    try {
      logger.info('Starting audio transcription...');
      // The chat's language, else the user's own language and accent (Settings › Voice and language), so an accent is never heard as another
      // language
      const language = spoken ?? (await voiceIdentityStore.getSettings()).language;

      // Create transcription message with audio data
      const transcriptionMessage = userMessage([
        textPart(
          `Transcribe this audio. ${listeningHint(voiceLanguageOf(language))}${vocabularyHint ? ` ${vocabularyHint}` : ''} Write it in that language as it was said. Return only the transcribed text without any additional formatting or explanations.`,
        ),
        { type: 'file', mediaType, data: base64Audio },
      ]);

      // Get transcription from Gemini
      const transcriptionResponse = await generatePlainText({ chatModel: this.llm, messages: [transcriptionMessage] });

      const transcribedText = transcriptionResponse.trim();
      logger.info('Audio transcription completed');

      return transcribedText;
    } catch (error) {
      logger.error('Failed to transcribe audio:', error);
      throw new Error(`Speech transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
