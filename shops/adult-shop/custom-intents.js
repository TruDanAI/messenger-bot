const { detectors } = require('../../core/rules');

/**
 * Intent đặc thù shop 18+: tuổi, gel, rung/pin.
 * Ghép vào config qua config.intents.prepend trong index.js.
 */
module.exports = {
  prepend: [
    {
      name: 'AGE_POLICY',
      match: ctx => detectors.wantsAgePolicy(ctx.text),
      handle: ctx => ctx.render('agePolicy', {
        shopName: ctx.config.shopName,
        minAge: ctx.config.minAge
      })
    },
    {
      name: 'GEL_KEYWORD',
      match: ctx => ctx.mentionsKeyword('gel'),
      handle: ctx => ctx.render('gelInfo')
    },
    {
      name: 'VIBRATION',
      match: ctx => ctx.wantsVibration,
      handle: ctx => ctx.render('vibrationOptions', {
        options: ctx.recommendationProducts('vibration')
          .map(p => `${p.code} giá ${p.price}`)
          .join(' và ')
          || 'một số mẫu có rung'
      })
    }
  ]
};
