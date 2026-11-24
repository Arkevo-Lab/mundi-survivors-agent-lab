// 059 simulation metadata. Keys match snapshot weapon properties and passive
// level properties. Descriptions summarize local effects, not original parity.
const freezeRows = rows => Object.freeze(Object.fromEntries(Object.entries(rows).map(([id,row])=>[id,Object.freeze(row)])));
export const WEAPON_METADATA = freezeRows({
  whip:{name:'鞭子',maxLevel:8,effect:'横向攻击敌人'},
  wand:{name:'魔杖',maxLevel:8,effect:'攻击附近敌人'},
  knife:{name:'飞刀',maxLevel:8,effect:'向面朝方向发射'},
  fireWand:{name:'火焰魔杖',maxLevel:8,effect:'发射火焰弹'},
  lightning:{name:'闪电戒指',maxLevel:8,effect:'以闪电攻击敌人'},
  santaWater:{name:'圣水',maxLevel:8,effect:'留下持续伤害区域'},
  axe:{name:'斧头',maxLevel:8,effect:'投掷可穿透敌人的斧头'},
  bible:{name:'圣经',maxLevel:8,effect:'书本环绕角色攻击'},
  cross:{name:'十字架',maxLevel:8,effect:'投掷折返的十字架'},
  runetracer:{name:'符文弹',maxLevel:8,effect:'发射反弹的投射物'},
  garlic:{name:'蒜香光环',maxLevel:8,effect:'周期性伤害附近敌人'},
  laurel:{name:'月桂护盾',maxLevel:7,effect:'充能并抵挡伤害'},
  clockLancet:{name:'时钟柳叶刀',maxLevel:7,effect:'沿方向冻结敌人'},
  pentagram:{name:'五芒星',maxLevel:8,effect:'清除视野内敌人，并可能清除地面物品'},
  peachone:{name:'Peachone',maxLevel:8,effect:'在环形区域轰炸'},
  ebonyWings:{name:'Ebony Wings',maxLevel:8,effect:'在环形区域轰炸'},
  vandalier:{name:'Vandalier',maxLevel:8,effect:'在双环区域轰炸'},
  bone:{name:'Bone',maxLevel:8,effect:'发射反弹骨头'}
});
export const PASSIVE_METADATA = freezeRows({
  hollowHeartLevel:{name:'空心之心',maxLevel:5,effect:'提高最大生命'},
  emptyTomeLevel:{name:'空白之书',maxLevel:5,effect:'缩短武器冷却'},
  bracerLevel:{name:'Bracer',maxLevel:5,effect:'提高投射物速度'},
  spinachLevel:{name:'菠菜',maxLevel:5,effect:'提高伤害'},
  candelabradorLevel:{name:'Candelabrador',maxLevel:5,effect:'扩大攻击范围'},
  spellbinderLevel:{name:'Spellbinder',maxLevel:5,effect:'延长武器持续时间'},
  cloverLevel:{name:'Clover',maxLevel:5,effect:'提高幸运'},
  wingsLevel:{name:'Wings',maxLevel:5,effect:'提高移动速度'},
  armorLevel:{name:'护甲',maxLevel:5,effect:'减少受到的伤害'},
  attractorLevel:{name:'Attractorb',maxLevel:5,effect:'扩大拾取范围'},
  crownLevel:{name:'Crown',maxLevel:5,effect:'提高获得的经验'},
  pummarolaLevel:{name:'Pummarola',maxLevel:5,effect:'每级每秒回复 0.2 生命'},
  duplicatorLevel:{name:'Duplicator',maxLevel:2,effect:'每级增加一个投射物'}
});
