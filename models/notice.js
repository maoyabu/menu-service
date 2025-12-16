import mongoose from 'mongoose';

const noticeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, default: '' },
  body: { type: String, default: '' },
  url: { type: String, default: '' },
  notifyMail: { type: Boolean, default: false },
  publishedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

const Notice = mongoose.models.Notice || mongoose.model('Notice', noticeSchema);
export default Notice;
