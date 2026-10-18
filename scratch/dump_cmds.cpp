#include <iostream>
#include <vector>
#include <string>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>
#include <lcf/rpg/event.h>
#include <lcf/rpg/eventpage.h>
#include <lcf/rpg/eventcommand.h>

int main(int argc, char** argv) {
    auto map = lcf::LMU_Reader::Load("Map0900.lmu", "");
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                if (cmd.code == 10810 || cmd.code == 10840 || cmd.code == 12210 || cmd.code == 10820 || cmd.code == 10830 || cmd.code == 12220) {
                    std::cout << "Event " << ev.ID << " Code " << cmd.code << " Params:";
                    for (int p : cmd.parameters) std::cout << " " << p;
                    std::cout << std::endl;
                }
            }
        }
    }
    return 0;
}
