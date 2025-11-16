import MailTemplateSetting from '../models/mailTemplateSetting.js';

/**
 * Check whether a given template should be sent based on admin settings.
 * Defaults to true when no setting exists (backward compatibility).
 */
export const shouldSendTemplate = async (templateName) => {
  if (!templateName) return false;
  try {
    const setting = await MailTemplateSetting.findOne({ templateName }).lean();
    if (!setting) return false; // 未設定は配信しない
    return !!setting.enabled;
  } catch (err) {
  console.warn('mail setting lookup failed:', err?.message || err);
    return false;
  }
};
