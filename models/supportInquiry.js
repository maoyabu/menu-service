import mongoose from 'mongoose';

const supportInquirySchema = new mongoose.Schema({
  email: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true }
}, { timestamps: { createdAt: 'entry_date', updatedAt: 'update_date' } });

const SupportInquiry = mongoose.model('SupportInquiry', supportInquirySchema);

export default SupportInquiry;
