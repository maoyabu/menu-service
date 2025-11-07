import mongoose from 'mongoose';

const { Schema } = mongoose;

const monthlyStockReminderSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  monthStart: { type: Date, required: true, index: true },
  sentAt: { type: Date, required: true },
  recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

monthlyStockReminderSchema.index({ group: 1, monthStart: 1 }, { unique: true });

const MonthlyStockReminder = mongoose.models.MonthlyStockReminder || mongoose.model('MonthlyStockReminder', monthlyStockReminderSchema);
export default MonthlyStockReminder;

