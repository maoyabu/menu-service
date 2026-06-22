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
    type: Date
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

const weeklyMenuTemplateSchema = new Schema({
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
  title: {
    type: String,
    default: ''
  },
  description: {
    type: String,
    default: ''
  },
  sourceWeekStart: {
    type: Date
  },
  dayPlans: {
    type: [dayPlanSchema],
    validate: {
      validator: (value) => Array.isArray(value) && value.length > 0,
      message: '少なくとも1日のメニューを含めてください'
    },
    required: true
  },
  dayComments: [{
    dayIndex: { type: Number, min: 0, max: 6, required: true },
    comment: { type: String, default: '' }
  }],
  editors: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }]
}, {
  timestamps: true
});

const WeeklyMenuTemplate = mongoose.models.WeeklyMenuTemplate || mongoose.model('WeeklyMenuTemplate', weeklyMenuTemplateSchema);

export default WeeklyMenuTemplate;
