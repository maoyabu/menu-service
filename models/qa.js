import mongoose from 'mongoose';

const qaSchema = new mongoose.Schema({
  qa_category: { type: String, required: true },
  qa_question: { type: String, required: true },
  qa_answer: { type: String, required: true },
  url: { type: String },
  faq_flag: { type: Boolean, default: false },
  entry_date: { type: Date, default: Date.now },
  update_date: { type: Date }
});

qaSchema.pre('findOneAndUpdate', function (next) {
  this.set({ update_date: Date.now() });
  next();
});

const Qa = mongoose.model('Qa', qaSchema);

export default Qa;
