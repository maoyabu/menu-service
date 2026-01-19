import mongoose from 'mongoose';

const { Schema } = mongoose;

const purchaseReminderLogSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  itemType: { type: String, enum: ['stock', 'equipment'], required: true },
  itemId: { type: Schema.Types.ObjectId, required: true },
  expiryDate: { type: Date, required: true },
  sentAt: { type: Date, required: true }
}, { timestamps: true });

purchaseReminderLogSchema.index({ group: 1, itemType: 1, itemId: 1, expiryDate: 1 }, { unique: true });

const PurchaseReminderLog = mongoose.models.PurchaseReminderLog || mongoose.model('PurchaseReminderLog', purchaseReminderLogSchema);
export default PurchaseReminderLog;
