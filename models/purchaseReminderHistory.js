import mongoose from 'mongoose';

const { Schema } = mongoose;

const purchaseReminderHistorySchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  itemType: { type: String, enum: ['stock', 'equipment'], required: true },
  itemId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, default: '' },
  prevExpiry: { type: Date, default: null },
  nextExpiry: { type: Date, default: null },
  purchasedAt: { type: Date, default: Date.now },
  purchasedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

purchaseReminderHistorySchema.index({ group: 1, purchasedAt: -1 });

const PurchaseReminderHistory = mongoose.models.PurchaseReminderHistory || mongoose.model('PurchaseReminderHistory', purchaseReminderHistorySchema);
export default PurchaseReminderHistory;
