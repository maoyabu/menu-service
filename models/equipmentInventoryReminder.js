import mongoose from 'mongoose';

const { Schema } = mongoose;

const equipmentInventoryReminderSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  cycleStart: { type: Date, required: true, index: true },
  cadence: { type: String, enum: ['monthly', 'quarter', 'half'], default: 'monthly' },
  sentAt: { type: Date, required: true },
  recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

equipmentInventoryReminderSchema.index({ group: 1, cycleStart: 1 }, { unique: true });

const EquipmentInventoryReminder = mongoose.models.EquipmentInventoryReminder || mongoose.model('EquipmentInventoryReminder', equipmentInventoryReminderSchema);
export default EquipmentInventoryReminder;
