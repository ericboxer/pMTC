var exports = (module.exports = {})

exports.nameFromEnumValue = function(enumGroup, value) {
  for (prop in enumGroup) {
    if (enumGroup[prop] == value) {
      return prop
    }
  }
}
