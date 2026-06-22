import mongoose from 'mongoose';

const { Schema } = mongoose;

const SLOT_TYPES = [
  'breakfast-main',
  'lunch-main',
  'dinner-staple',
  'dinner-main',
  'dinner-side',
  'dinner-soup',
  'dinner-flex'
];

const menuSlotSchema = new Schema({
  slotType: {
    type: String,
    enum: SLOT_TYPES,
    required: true
  },
  menu: {
    type: Schema.Types.ObjectId,
    ref: 'Menu',
    required: true
  },
  dineOut: {
    type: Boolean,
    default: false
  },
  dineOutName: {
    type: String,
    default: ''
  },
  dineOutUrl: {
    type: String,
    default: ''
  },
  favorite: {
    type: Boolean,
    default: false
  },
  locked: {
    type: Boolean,
    default: false
  },
  // 追加作り置き人数（デフォルト0人）
  prepExtra: {
    type: Number,
    default: 0,
    min: 0
  },
  servingMultiplier: {
    type: Number,
    default: 1,
    min: 0.1,
    max: 99
  }
});
 

const dayPlanSchema = new Schema({
  dayIndex: {
    type: Number,
    min: 0,
    max: 6,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  mealType: {
    type: String,
    enum: ['breakfast', 'lunch', 'dinner'],
    required: true
  },
  slots: {
    type: [menuSlotSchema],
    validate: {
      validator: (value) => Array.isArray(value) && value.length > 0,
      message: '少なくとも1つのメニューを設定してください'
    },
    required: true
  }
}, { _id: false });

// 参加者情報を日付・食事単位で保持（スロットとは独立して管理する）
const participantEntrySchema = new Schema({
  dayIndex: {
    type: Number,
    min: 0,
    max: 6,
    required: true
  },
  mealType: {
    type: String,
    enum: ['breakfast', 'lunch', 'dinner'],
    required: true
  },
  users: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }]
}, { _id: false });

const weeklyMenuPlanSchema = new Schema({
  group: {
    type: Schema.Types.ObjectId,
    ref: 'Group',
    required: true,
    index: true
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  weekStart: {
    type: Date,
    required: true
  },
  weekEnd: {
    type: Date,
    required: true
  },
  title: {
    type: String
  },
  description: {
    type: String
  },
  dayPlans: {
    type: [dayPlanSchema],
    validate: {
      validator: (value) => Array.isArray(value) && value.length > 0,
      message: '少なくとも1日のメニューを含めてください'
    },
    required: true
  },
  // 参加者（任意）：各日×昼/夜の参加ユーザー
  participants: {
    type: [participantEntrySchema],
    default: []
  },
  // 任意: 日単位のコメント
  dayComments: [{
    dayIndex: { type: Number, min: 0, max: 6, required: true },
    date: { type: Date },
    comment: { type: String, default: '' }
  }],
  // 任意: 参加しない理由の履歴（ユーザーごと / 日×食事単位）
  participantReasons: [{
    dayIndex: { type: Number, min: 0, max: 6 },
    mealType: { type: String, enum: ['breakfast', 'lunch', 'dinner'] },
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
  }],
  isPublished: {
    type: Boolean,
    default: false
  },
  publishedAt: {
    type: Date
  },
  editors: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
  timestamps: true
});

weeklyMenuPlanSchema.index({ 'dayPlans.date': 1 });

weeklyMenuPlanSchema.pre('validate', function setWeekEnd(next) {
  if (this.weekStart && !this.weekEnd) {
    const end = new Date(this.weekStart);
    end.setDate(end.getDate() + 6);
    this.weekEnd = end;
  }
  next();
});

const WeeklyMenuPlan = mongoose.models.WeeklyMenuPlan || mongoose.model('WeeklyMenuPlan', weeklyMenuPlanSchema);

export default WeeklyMenuPlan;
