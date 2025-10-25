import mongoose from 'mongoose';

const { Schema } = mongoose;

const SLOT_TYPES = [
  'lunch-main',
  'dinner-staple',
  'dinner-main',
  'dinner-side',
  'dinner-soup'
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
  favorite: {
    type: Boolean,
    default: false
  },
  locked: {
    type: Boolean,
    default: false
  }
}, { _id: false });

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
    enum: ['lunch', 'dinner'],
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