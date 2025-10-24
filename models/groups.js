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
