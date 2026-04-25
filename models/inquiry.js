import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  content: { type: String, required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isAdmin: { type: Boolean, default: false },
  mail_delivery: { type: Boolean, default: true },
  mail_sent: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
  entry_date: { type: Date, default: Date.now },
  update_date: { type: Date }
});

const inquirySchema = new mongoose.Schema({
  title: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  closed: { type: Boolean, default: false },
  messages: [messageSchema]
}, {
  timestamps: { createdAt: 'entry_date', updatedAt: 'update_date' }
});

inquirySchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Inquiry = mongoose.model('Inquiry', inquirySchema);

export default Inquiry;
