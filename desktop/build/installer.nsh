; Registers Halcyon as an email client so it can be chosen in Windows "Default apps" (mailto:).
!macro customInstall
  WriteRegStr HKCU "Software\Clients\Mail\Halcyon" "" "Halcyon"
  WriteRegStr HKCU "Software\Clients\Mail\Halcyon\Capabilities" "ApplicationName" "Halcyon"
  WriteRegStr HKCU "Software\Clients\Mail\Halcyon\Capabilities" "ApplicationDescription" "AI-native email, calendar and contacts"
  WriteRegStr HKCU "Software\Clients\Mail\Halcyon\Capabilities\URLAssociations" "mailto" "Halcyon.mailto"
  WriteRegStr HKCU "Software\Classes\Halcyon.mailto" "" "Halcyon mailto handler"
  WriteRegStr HKCU "Software\Classes\Halcyon.mailto" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\Halcyon.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Halcyon.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\RegisteredApplications" "Halcyon" "Software\Clients\Mail\Halcyon\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\Mail\Halcyon"
  DeleteRegKey HKCU "Software\Classes\Halcyon.mailto"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Halcyon"
!macroend
