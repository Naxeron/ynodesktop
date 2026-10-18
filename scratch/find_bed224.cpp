#include <iostream>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0224.lmu", "");
    if (!map) return 1;
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code == 10810 && cmd.parameters.size() >= 3) {
                    std::cout << "Event ID: " << ev.ID << " Name: " << ev.name << " Target: " << cmd.parameters[0] << "\n";
                }
            }
        }
    }
    return 0;
}
