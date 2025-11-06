import mongoose from 'mongoose';

const { Schema } = mongoose;

const weeklyAnnouncementSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  weekStart: { type: Date, required: true, index: true },
  sentAt: { type: Date, required: true },
  recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

weeklyAnnouncementSchema.index({ group: 1, weekStart: 1 }, { unique: true });

const WeeklyAnnouncement = mongoose.models.WeeklyAnnouncement || mongoose.model('WeeklyAnnouncement', weeklyAnnouncementSchema);
export default WeeklyAnnouncement;

