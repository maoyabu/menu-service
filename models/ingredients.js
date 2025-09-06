import mongoose from 'mongoose';

const ingredientsSchema = new mongoose.Schema({
    classification: {
        type: String
    },
    ingredient: {
        type: String,
        required: true
    },
    yomi: {
        type: String
    },
    energy: {
        type: Number
    },
    water: {
        type: Number
    },
    protein: {
        type: Number
    },
    lipid: {
        type: Number
    },
    carbohydrate: {
        type: Number
    },
    unit: {
        type: [String]  // 例: ['g', 'ml']
    },
    season: {
        type: [String]  // 例: ['春', '夏']
    },
    month: {
        type: [String]  // 例: ['3月', '4月']
    },
    comment: {
        type: String
    },
    favorite: {
        type: Boolean,
        default: false
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    },
    used_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定する
ingredientsSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const Ingredient = mongoose.models.Ingredient || mongoose.model('Ingredient', ingredientsSchema);
export default Ingredient;