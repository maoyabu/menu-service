import mongoose from 'mongoose';

const { Schema } = mongoose;

const groupSchema = new Schema({
  group_name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  members: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  invitedUsers: {
    type: [String],
    default: []
  },
  // Service availability can be configured independently for each member.
  // Members without an entry retain access to every service for compatibility.
  memberServicePermissions: [{
    _id: false,
    member: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    services: {
      plan: { type: Boolean, default: true },
      stock: { type: Boolean, default: true },
      packing: { type: Boolean, default: true },
      board: { type: Boolean, default: true }
    }
  }],
  // Group-level settings
  stockInventory: {
    enabled: { type: Boolean, default: true },
    // mode: 'monthlyDay' | 'nthWeekday'
    mode: { type: String, enum: ['monthlyDay', 'nthWeekday'], default: 'monthlyDay' },
    // For monthlyDay
    day: { type: Number, default: 28 }, // 1-31, clamped per month
    // For nthWeekday (1-5 and 0-6 for Sun-Sat)
    nth: { type: Number, default: 4 },
    weekday: { type: Number, default: 0 },
    // Send hour in 24h
    sendHour: { type: Number, default: 8 },
    // Suggested completion window (days)
    windowDays: { type: Number, default: 7 }
  },
  equipmentInventory: {
    enabled: { type: Boolean, default: true },
    cadence: { type: String, enum: ['monthly', 'quarter', 'half'], default: 'monthly' }
  }
}, { timestamps: true });

const toIdString = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value._id) return value._id.toString();
  return null;
};

groupSchema.virtual('memberCount').get(function () {
  const ids = new Set();
  if (Array.isArray(this.members)) {
    this.members.forEach((member) => {
      const id = toIdString(member);
      if (id) ids.add(id);
    });
  }
  const ownerId = toIdString(this.createdBy);
  if (ownerId) {
    ids.add(ownerId);
  }
  return ids.size;
});

const Group = mongoose.models.Group || mongoose.model('Group', groupSchema);
export default Group;
