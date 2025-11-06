import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationItemSchema = new Schema({
  // for not-eating/eatingAgain
  date: { type: Date },
  mealType: { type: String, enum: ['lunch', 'dinner'] },
  reason: { type: String, default: '' },
  // for myMenuAdded
  name: { type: String, default: '' }
}, { _id: false, strict: true });

const notificationSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['notEating', 'eatingAgain'], required: true },
  scheduledAt: { type: Date, required: true, index: true },
  sentAt: { type: Date },
  status: { type: String, enum: ['pending', 'sent'], default: 'pending', index: true },
  items: { type: [notificationItemSchema], default: [] }
}, { timestamps: true });

const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
export default Notification;
