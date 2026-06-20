import mongoose from 'mongoose';

const { Schema } = mongoose;

const dailyMenuAnnouncementSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
  sentAt: { type: Date, required: true }
}, { timestamps: true });

dailyMenuAnnouncementSchema.index(
  { group: 1, recipient: 1, dateKey: 1 },
  { unique: true }
);

const DailyMenuAnnouncement = mongoose.models.DailyMenuAnnouncement
  || mongoose.model('DailyMenuAnnouncement', dailyMenuAnnouncementSchema);

export default DailyMenuAnnouncement;
