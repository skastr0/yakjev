require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'YakjevGraph'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.author = package['author']
  s.license = package['license']
  s.homepage = 'https://github.com/skastr0/yakjev'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks = ['Metal', 'MetalKit', 'QuartzCore', 'UIKit']
  s.source_files = '**/*.swift'
  # Ship the exact shader source as a resource. Metal compiles it once at view
  # initialization; this works in device and simulator builds without requiring
  # a separately downloaded Metal command-line compiler during pod installation.
  s.resource_bundles = { 'YakjevGraphShaders' => ['Shaders/*.metal'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
