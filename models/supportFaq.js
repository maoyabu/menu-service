import mongoose from 'mongoose';

const supportFaqSchema = new mongoose.Schema({
  qa_category: { type: String, default: '' },
  qa_question: { type: String, required: true },
  qa_answer: { type: String, required: true },
  url: { type: String, default: '' },
  faq_flag: { type: Boolean, default: true }
}, { timestamps: true });

const SupportFAQ = mongoose.model('SupportFAQ', supportFaqSchema);

export default SupportFAQ;
