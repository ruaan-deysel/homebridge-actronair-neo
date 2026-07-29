import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  stylistic: { indent: 2, quotes: 'single', semi: false },
  ignores: ['dist', 'coverage', 'homebridge-ui/public', 'docs/superpowers', '.superpowers'],
})
