import mongoose from 'mongoose';

const { Schema } = mongoose;

const foodGuidelineSchema = new Schema({
  ageStart: {
    type: Number,
    required: true,
    min: 0
  },
  ageEnd: {
    type: Number,
    default: null
  },
  sex: {
    type: String,
    enum: ['男', '女', ''],
    default: ''
  },
  classification: {
    type: String,
    required: true,
    trim: true
  },
  requiredGrams: {
    type: Number,
    required: true,
    min: 0
  }
}, { timestamps: true });

const FoodGuideline = mongoose.models.FoodGuideline || mongoose.model('FoodGuideline', foodGuidelineSchema);

export default FoodGuideline;
