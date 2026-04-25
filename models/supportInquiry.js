import mongoose from 'mongoose';

const supportMessageSchema = new mongoose.Schema({
  content: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
  entry_date: { type: Date, default: Date.now }
}, { _id: true });

const supportInquirySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, required: true },
  title: { type: String, required: true },
  status: { type: String, default: 'open' },
  closed: { type: Boolean, default: false },
  messages: { type: [supportMessageSchema], default: [] },
  message: { type: String, default: '' }
}, { timestamps: { createdAt: 'entry_date', updatedAt: 'update_date' } });

const SupportInquiry = mongoose.model('SupportInquiry', supportInquirySchema);

export default SupportInquiry;
