import mongoose from 'mongoose';

const { Schema } = mongoose;

const shoppingListStateSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  weekStart: { type: Date, required: true, index: true },
  state: { type: Map, of: Boolean, default: {} },
  dates: { type: Map, of: String, default: {} },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

shoppingListStateSchema.index({ group: 1, weekStart: 1 }, { unique: true });

const ShoppingListState = mongoose.models.ShoppingListState || mongoose.model('ShoppingListState', shoppingListStateSchema);
export default ShoppingListState;
