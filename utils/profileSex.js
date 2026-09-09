const SEX_VALUE_ALIASES = new Map([
  ['male', '男性'],
  ['man', '男性'],
  ['男', '男性'],
  ['男性', '男性'],
  ['female', '女性'],
  ['woman', '女性'],
  ['女', '女性'],
  ['女性', '女性'],
  ['other', 'その他'],
  ['その他', 'その他'],
  ['no_answer', '回答しない'],
  ['no-answer', '回答しない'],
  ['prefer_not_to_say', '回答しない'],
  ['回答しない', '回答しない']
]);

export const normalizeProfileSex = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  return SEX_VALUE_ALIASES.get(normalized.toLowerCase()) || normalized;
};
