import mongoose from 'mongoose';

const publicInquirySchema = new mongoose.Schema({
  email: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  entry_date: { type: Date, default: Date.now },
  update_date: { type: Date }
});

publicInquirySchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const PublicInquiry = mongoose.model('PublicInquiry', publicInquirySchema);

export default PublicInquiry;
