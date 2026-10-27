Pod::Spec.new do |s|
  s.name           = 'T3Voice'
  s.version        = '0.0.0'
  s.summary        = 'On-device speech conversations for T3 Code.'
  s.description    = 'Microphone recognition and spoken replies without storing audio files.'
  s.homepage       = 'https://github.com/eding42/t3code-carplay'
  s.license        = { :type => 'MIT' }
  s.author         = 'T3 Code contributors'
  s.platforms      = { :ios => '16.1' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files   = '**/*.{h,m,mm,swift,hpp,cpp}'
  s.frameworks     = 'AVFoundation', 'Speech'
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
end
