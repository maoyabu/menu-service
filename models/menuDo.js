import mongoose from 'mongoose';

const { Schema } = mongoose;

const menuDoSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  plan: { type: Schema.Types.ObjectId, ref: 'WeeklyMenuPlan', index: true },
  date: { type: Date, required: true, index: true },
  dayIndex: { type: Number, min: 0, max: 6, required: true },
  mealType: { type: String, enum: ['breakfast', 'lunch', 'dinner'], required: true, index: true },
  menu: { type: Schema.Types.ObjectId, ref: 'Menu', required: true, index: true },
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Avoid duplicate DO records per user/menu/date/meal/group
menuDoSchema.index({ group: 1, date: 1, mealType: 1, menu: 1, recordedBy: 1 }, { unique: true });

const MenuDo = mongoose.models.MenuDo || mongoose.model('MenuDo', menuDoSchema);

export default MenuDo;
