import mongoose from 'mongoose';

const { Schema } = mongoose;

const recurrenceSchema = new Schema({
  type: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  interval: { type: Number, default: 1 }, // every N days/weeks/months
  weekdays: [{ type: Number }], // 0=Sun ... 6=Sat
  dayOfMonth: { type: Number, default: null }
}, { _id: false });

const taskSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  title: { type: String, required: true, trim: true },
  category: { type: String, default: '', trim: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assignees: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  startAt: { type: Date, default: null },
  dueAt: { type: Date, default: null },
  started: { type: Boolean, default: false },
  status: { type: String, enum: ['not_started', 'in_progress', 'on_hold', 'completed'], default: 'not_started', index: true },
  completedAt: { type: Date, default: null },
  note: { type: String, default: '' },
  recurrence: { type: recurrenceSchema, default: () => ({}) },
  source: { type: String, enum: ['manual', 'packing', 'stock', 'equipment'], default: 'manual', index: true },
  sourceId: { type: Schema.Types.ObjectId, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

taskSchema.index({ group: 1, dueAt: 1 });
taskSchema.index({ group: 1, assignees: 1 });

taskSchema.pre('save', function(next){
  this.updatedAt = new Date();
  next();
});

const Task = mongoose.models.Task || mongoose.model('Task', taskSchema);
export default Task;
