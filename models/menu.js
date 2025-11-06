import mongoose from 'mongoose';

const menuSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    kind: {
        type: String,
        required: true
    },
    menu: {
        type: String
    },
    yomi:{
        type: String
    },
    junle: {
        type: String,
        required: true
    },
    cook: {
        type: String,
        required: true
    },
    url: {
        type: String,
        default: ''
    },
    imageUrl: {
        type: String,
        default: ''
    },
    time: {
        type: String,
    },
    people: {
        type: Number,
        required: true
    },
    ingredients: [
    {
        name: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Ingredient' // 正しいモデル名
        },
        amount: Number,
        unit: String
    }
    ],
    seasoning: [
    {
        name: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seasoning' // 正しいモデル名
        },
        amount: Number,
        unit: String
    }
    ],
    material:{
        type: Boolean,
        default: false
    },
    comment: {
        type: String
    },
    instructionText: {
        type: String,
        default: ''
    },
    share: {
        type: Boolean,
        default: false
    },
    entry_date:{
        type: Date,
        default: Date.now
    },
    update_date: {
        type: Date
    }
});

// 🔹 更新時に update_date を自動設定する
menuSchema.pre('findOneAndUpdate', function (next) {
    this.set({ update_date: Date.now() }); // update_date を現在の日時に設定
    next();
});

const existingModel = mongoose.models.Menu;
if (existingModel) {
    mongoose.deleteModel('Menu');
}
const Menu = mongoose.model('Menu', menuSchema);
// ES モジュール形式用に default エクスポートを追加
export default Menu;
